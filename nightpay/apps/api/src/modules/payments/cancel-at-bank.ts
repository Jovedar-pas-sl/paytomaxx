import { ConflictException } from '@nestjs/common';
import { CANCEL_AT_BANK_AFTER_MS, CANCEL_AT_BANK_TOO_SOON_CODE, cancelAtBankWaitMs } from '@nightpay/contracts';
import type { Prisma } from '@nightpay/db';
import { isHeldOnReader } from './reader-hold';

/**
 * «Cancelar cobro» con el cliente en la página de su banco (decisión del
 * dueño): no durante los primeros 2 minutos (CANCEL_AT_BANK_AFTER_MS) desde
 * que salió al banco; pasados sin respuesta del banco, sí. Con bitcoin no hay
 * banco: su factura abierta se cancela sin esperar. La recarga cobrada en el
 * datáfono sin comprobar tampoco está en su banco (la tarjeta ya pagó): esa no
 * se cancela nunca (reader-hold.ts).
 *
 * «Salió al banco» = lo más reciente de dos marcas que se escriben en la MISMA
 * transacción que pone el cobro en AUTHORIZING y que nada más mueve: el
 * `createdAt` del último intento (payment_attempts; un reintento de Redsys es
 * otra visita al banco) y el evento `payment.authorizing` (payment_events; por
 * si el cobro no tiene intento). No `updatedAt`: cambia con cualquier otra cosa.
 */

type RawDb = Pick<Prisma.TransactionClient, '$queryRaw'>;

/**
 * El cliente en la página de su banco: AUTHORIZING con una pasarela. Con
 * bitcoin, no; ni la recarga cobrada en el datáfono sin comprobar (con su
 * operación del datáfono: ya está cobrada y no se cancela).
 */
export function isAtBank(p: { status: string; provider: string | null; posOperationNumber?: string | null }): boolean {
  return p.status === 'AUTHORIZING' && p.provider !== 'BTCPAY' && !isHeldOnReader(p);
}

/** Desde cuándo está cada cobro en su banco (según la base) y la hora de la base. */
export interface BankVisits {
  now: Date;
  since: ReadonlyMap<string, Date>;
}

/**
 * Para varios cobros de un local a la vez (la lista «Sin pagar») o uno solo
 * (cancelar, con el cobro bloqueado). La hora de la base va con ellas: las
 * dos del mismo reloj.
 */
export async function bankVisitsSince(db: RawDb, tenantId: string, paymentIds: readonly string[]): Promise<BankVisits> {
  if (paymentIds.length === 0) return { now: new Date(), since: new Map() };
  const rows = await db.$queryRaw<Array<{ id: string; since: Date | null; now: Date }>>`
    SELECT p.id::text AS id,
           GREATEST(
             (SELECT MAX(a."createdAt") FROM payment_attempts a WHERE a."paymentId" = p.id),
             (SELECT MAX(e."occurredAt") FROM payment_events e WHERE e."paymentId" = p.id AND e."eventType" = 'payment.authorizing')
           ) AS since,
           now() AS now
      FROM payments p
     WHERE p."tenantId" = ${tenantId}::uuid AND p.id = ANY(${[...paymentIds]}::uuid[])
  `;
  const since = new Map<string, Date>();
  for (const r of rows) if (r.since) since.set(r.id, r.since);
  return { now: rows[0]?.now ?? new Date(), since };
}

/** Lo que falta (ms) para poder cancelar este cobro; 0 = ya se puede (no está en su banco, o pasaron los 2 min). */
export function cancelWaitMsOf(
  p: { id: string; status: string; provider: string | null; posOperationNumber?: string | null },
  visits: BankVisits,
): number {
  if (!isAtBank(p)) return 0;
  return cancelAtBankWaitMs(visits.since.get(p.id)?.getTime() ?? null, visits.now.getTime());
}

/** El 409 de cancelar antes de tiempo: la app del personal lo distingue por el código y sabe cuánto falta. */
export function cancelTooSoon(waitMs: number): ConflictException {
  const seconds = Math.ceil(waitMs / 1000);
  return new ConflictException({
    code: CANCEL_AT_BANK_TOO_SOON_CODE,
    message: `El cliente está pagando en su banco. Si el banco no responde en ${CANCEL_AT_BANK_AFTER_MS / 60_000} minutos, podrás cancelar.`,
    retryInSeconds: seconds,
  });
}

/**
 * Dentro de cancel(), con el cobro bloqueado (FOR UPDATE): con el cliente en
 * su banco y antes de los 2 minutos, 409. Sin marca de cuándo salió al banco
 * (cobros muy antiguos) no se frena: el cobro lleva ahí desde antes.
 */
export async function assertBankWaitOver(
  tx: RawDb,
  locked: { id: string; tenantId: string; status: string; provider: string | null; posOperationNumber?: string | null },
): Promise<void> {
  if (!isAtBank(locked)) return;
  const wait = cancelWaitMsOf(locked, await bankVisitsSince(tx, locked.tenantId, [locked.id]));
  if (wait > 0) throw cancelTooSoon(wait);
}
