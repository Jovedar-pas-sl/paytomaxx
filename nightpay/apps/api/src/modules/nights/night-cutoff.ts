import type { Prisma } from '@nightpay/db';

/**
 * El corte del Z de una noche y por qué hay que esperar un poco antes de leerlo.
 *
 * Regla única: un apunte cuenta en el Z cuyo corte es el primero posterior a
 * cuándo se apuntó (payment_events.occurredAt del primer «pagado», la creación
 * de la devolución o de la recarga, la anulación del consumo). Si su fecha es
 * de esa noche, sale en el resumen; si es de una noche ya cerrada, como
 * ajuste. El Z siguiente empieza justo en ese corte (zStart: desde = el cierre,
 * ajustes desde = el corte). Así cada apunte sale en un Z y solo en uno.
 *
 * La carrera: esas horas las pone la base al empezar la transacción (NOW()) o
 * el servidor al escribir, pero la fila no se ve hasta el COMMIT. Un cobro que
 * se confirma justo mientras se calcula el Z lleva una hora anterior al corte
 * y aún no se ve: el Z no lo cuenta y el siguiente tampoco (es de antes de su
 * corte). Por eso, antes de leer las filas del Z, se espera a que terminen las
 * transacciones de la base que empezaron antes del corte (pg_stat_activity, de
 * todas las réplicas del API) y a que el reloj de la base pase el corte (por
 * si el del servidor va adelantado). Las de la app duran como mucho 5 s
 * (timeout de las transacciones de Prisma): se espera hasta 6 s.
 */

/** Más que el timeout de las transacciones interactivas de Prisma (5 s). */
export const CUTOFF_SETTLE_MAX_WAIT_MS = 6_000;
export const CUTOFF_SETTLE_POLL_MS = 50;
/**
 * Una transacción abierta desde mucho antes del corte no es de la app (las de
 * Prisma se cortan a los 5 s): una copia de seguridad o una consola. No se espera por ella.
 */
export const CUTOFF_STALE_TX_MS = 60_000;

export interface SettleResult {
  /** Todo lo que empezó antes del corte ha terminado. */
  settled: boolean;
  /** Transacciones de antes del corte que seguían abiertas al rendirse (0 si settled). */
  open: number;
  waitedMs: number;
}

interface SettleDb {
  $queryRaw<T = unknown>(query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]): Prisma.PrismaPromise<T>;
}

interface SettleOptions {
  maxWaitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Espera a que lo apuntado con hora anterior a `cutoff` esté a la vista: sin
 * transacciones de otras sesiones de esta base empezadas antes del corte (y
 * después de CUTOFF_STALE_TX_MS antes) y con el reloj de la base ya pasado el corte.
 */
export async function settleWritesBefore(db: SettleDb, cutoff: Date, opts: SettleOptions = {}): Promise<SettleResult> {
  const maxWaitMs = opts.maxWaitMs ?? CUTOFF_SETTLE_MAX_WAIT_MS;
  const pollMs = opts.pollMs ?? CUTOFF_SETTLE_POLL_MS;
  const sleep = opts.sleep ?? pause;
  const staleBefore = new Date(cutoff.getTime() - CUTOFF_STALE_TX_MS);
  const started = Date.now();
  // También por vueltas: con un reloj parado (pruebas) no se queda esperando para siempre.
  const maxRounds = Math.ceil(maxWaitMs / Math.max(pollMs, 1));
  for (let round = 0; ; round += 1) {
    const [row] = await db.$queryRaw<Array<{ past: boolean; open: number }>>`
      SELECT clock_timestamp() > ${cutoff} AS "past",
             (SELECT count(*)::int
                FROM pg_stat_activity a
               WHERE a.datname = current_database()
                 AND a.pid <> pg_backend_pid()
                 AND a.backend_type = 'client backend'
                 AND a.xact_start < ${cutoff}
                 AND a.xact_start > ${staleBefore}) AS "open"
    `;
    const open = Number(row?.open ?? 0);
    const waitedMs = Date.now() - started;
    if (row?.past === true && open === 0) return { settled: true, open: 0, waitedMs };
    if (waitedMs >= maxWaitMs || round >= maxRounds) return { settled: false, open, waitedMs };
    await sleep(pollMs);
  }
}
