import { Prisma } from '@nightpay/db';

/**
 * Reglas comunes de TODOS los informes: métricas del panel, Z de la noche, Z
 * del periodo, IVA 303 e informe de la gestoría. Si un informe cuenta algo
 * distinto que otro, es un fallo: las fechas y filtros salen de aquí.
 *
 *  - Local: siempre explícito en el SQL (`"tenantId" = …`). Nada depende del
 *    filtro del middleware de Prisma (los consumos del saldo no lo tienen).
 *  - Cobros: los pagados (AUTHORIZED, PARTIALLY_REFUNDED, REFUNDED), en el
 *    momento en que el banco los autorizó (authorizedAt; si falta, createdAt).
 *  - Devoluciones: las hechas (SUCCEEDED), el día en que se hicieron en el
 *    banco (bankRefundedAt; si falta, cuando se apuntaron).
 *  - Saldo devuelto al cliente: el de efectivo (wallet_payouts CASH) cuenta
 *    cuando se apuntó y se resta de lo cobrado. El devuelto a la tarjeta ya
 *    son devoluciones de las recargas: solo se informa (no se resta dos veces).
 *  - Consumos del saldo: los no anulados, cuando se hicieron. No son dinero
 *    nuevo (entró con la recarga): son ventas por tipo y la parte de la chica.
 *  - Propinas: son dinero cobrado (cuentan en «cobrado» y en «neto»), pero no
 *    son base del IVA. Lo devuelto se reparte entre importe y propina en
 *    proporción a lo cobrado, como el descuento a la chica (refund-share.ts).
 *  - Neto = importe + propinas − devoluciones − saldo devuelto en efectivo.
 *  - Días, meses y trimestres de Madrid (reporting-window.ts, report-period.ts).
 */

/**
 * Tiempos de las transacciones de los informes (Z al cerrar y su cierre
 * automático de las 08:00, resumen de las 9:00, Z del periodo, CSV, mapa del
 * dinero). Con los de Prisma (5 s) un local con mucho historial o la base
 * ocupada cortaba la transacción (P2028): el cierre automático fallaba cada
 * 10 min sin cerrar la noche y el panel daba 500. Con los índices de
 * 20261029400000 tardan milisegundos: esto es el tope, no lo normal.
 */
export const REPORT_TX = { maxWait: 10_000, timeout: 30_000 } as const;

/** Estados de un cobro que cuentan como cobrado. */
export const PAID_STATUSES_SQL = Prisma.sql`('AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED')`;

/** Eventos de payment_events que dejan un cobro pagado (transition()). */
export const PAID_EVENTS_SQL = Prisma.sql`('payment.authorized', 'payment.pos_confirmed')`;

/** Momento de un cobro: autorización del banco (o creación si falta). `p` = alias de payments. */
export function paymentAt(p: string): Prisma.Sql {
  return Prisma.raw(`COALESCE(${p}."authorizedAt", ${p}."createdAt")`);
}

/**
 * Cuántas recargas en efectivo (`ct` = alias de wallet_cash_topups): las
 * anulaciones (filas negativas, 20261021200000) restan una. El importe es la
 * suma tal cual: la anulación ya es negativa.
 */
export function cashTopUpCount(ct: string): Prisma.Sql {
  return Prisma.raw(`(COUNT(*) FILTER (WHERE ${ct}."amountCents" > 0) - COUNT(*) FILTER (WHERE ${ct}."amountCents" < 0))`);
}

/** Momento de una devolución: el día del banco (o cuando se apuntó). `r` = alias de refunds. */
export function refundAt(r: string): Prisma.Sql {
  return Prisma.raw(`COALESCE(${r}."bankRefundedAt", ${r}."createdAt")`);
}

/**
 * Cuándo se apuntó aquí que el cobro está pagado: el primer evento que lo dejó
 * pagado. Puede ser posterior a su momento (aviso del banco que llega tarde,
 * cobro resuelto a mano). Sin eventos (cobros antiguos), su propio momento.
 */
export function paymentRecordedAt(p: string): Prisma.Sql {
  return Prisma.sql`COALESCE(
    (SELECT MIN(pe."occurredAt") FROM payment_events pe
      WHERE pe."paymentId" = ${Prisma.raw(`${p}.id`)} AND pe."eventType" IN ${PAID_EVENTS_SQL}),
    ${paymentAt(p)}
  )`;
}

/**
 * Parte de una devolución que era propina (proporcional a lo cobrado: importe
 * + «Comisión del servicio» + propina; sin comisión, como siempre). La de la
 * comisión se apunta en la devolución (refunds."serviceFeeCents").
 */
export function refundTipPart(r: string, p: string): Prisma.Sql {
  return Prisma.raw(
    `ROUND(${r}."amountCents"::numeric * ${p}."tipCents" / NULLIF(${p}."amountCents" + ${p}."serviceFeeCents" + ${p}."tipCents", 0))`,
  );
}

/**
 * Las líneas de un cobro como JSON [{ category, amountCents }], en su orden
 * (`l` = alias de payment_lines; para json_agg dentro de un SELECT … FROM payment_lines l).
 */
export function linesJson(l: string): Prisma.Sql {
  return Prisma.raw(
    `json_agg(json_build_object('category', ${l}.category, 'amountCents', ${l}."amountCents") ORDER BY ${l}."createdAt", ${l}."amountCents" DESC, ${l}.id)`,
  );
}

/** Lo que una chica ya debe de un cobro que se le pagó antes de devolverlo. `e` = alias del earning. */
export function afterPayoutDebt(e: string): Prisma.Sql {
  return Prisma.raw(`COALESCE((
    SELECT SUM(er."reversedDeltaCents") FROM earning_reversals er
     WHERE er."earningId" = ${e}.id AND er."afterPayout"
  ), 0)`);
}
