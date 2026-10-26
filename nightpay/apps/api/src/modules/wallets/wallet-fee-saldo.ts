import type { Prisma } from '@nightpay/db';

/**
 * El saldo cargado CON «Comisión del servicio» y el cargado SIN ella (decisión
 * del dueño, 2026-10-26): al gastarlo, lo cargado con ella no paga nada más
 * (el cliente ya la pagó al recargar), y lo cargado sin ella paga el % antiguo
 * de plataforma a cargo del local, como siempre. Da igual el interruptor al
 * gastarlo: lo decide cómo se cargó (así encender y apagar cuadra).
 *
 * Una recarga es «con comisión» si se hizo con el interruptor encendido
 * (`serviceFeeBps` no nulo, también al 0 %: entonces OxioPay no cobra nada,
 * y la consola lo avisa al encenderla).
 *
 * El orden es el de siempre en un saldo: se gasta primero lo más antiguo. Lo
 * ya gastado o devuelto es lo más antiguo, así que lo que queda en el saldo
 * son las recargas más recientes; el saldo que no sale en las recargas
 * apuntadas (de antes) cuenta como sin comisión y lo más antiguo. Se lleva
 * por saldo y por los sumados a él (mergedIntoId), como el efectivo para los
 * topes (wallet-cash-limits.ts).
 */

/** Una recarga del saldo (efectivo con sus anulaciones, o tarjeta) y si llevó comisión. */
export interface SaldoCredit {
  at: Date;
  cents: number;
  withServiceFee: boolean;
}

/** De un gasto de `spendCents` (importe + propina), lo que sale de lo cargado con comisión. */
export function serviceFeeSpendCents(credits: readonly SaldoCredit[], balanceCents: number, spendCents: number): number {
  const spend = Math.max(0, Math.min(spendCents, balanceCents));
  if (spend === 0) return 0;
  const ordered = credits
    .filter((c) => c.cents > 0)
    .map((c, i) => ({ ...c, i }))
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.i - b.i);
  // Lo que queda del saldo, de lo más antiguo a lo más reciente.
  const left: Array<{ cents: number; withServiceFee: boolean }> = [];
  let toCover = balanceCents;
  for (let k = ordered.length - 1; k >= 0 && toCover > 0; k -= 1) {
    const c = ordered[k]!;
    const part = Math.min(c.cents, toCover);
    left.unshift({ cents: part, withServiceFee: c.withServiceFee });
    toCover -= part;
  }
  if (toCover > 0) left.unshift({ cents: toCover, withServiceFee: false });
  let rest = spend;
  let fromFee = 0;
  for (const lot of left) {
    if (rest === 0) break;
    const part = Math.min(lot.cents, rest);
    if (lot.withServiceFee) fromFee += part;
    rest -= part;
  }
  return fromFee;
}

/**
 * La parte del consumo (sin la propina) pagada con saldo de la comisión: en
 * proporción a lo que salió de ahí (wallet_consumptions."serviceFeeSaldoCents").
 * El % antiguo va sobre el resto.
 */
export function serviceFeeSaldoCents(c: { amountCents: number; tipCents: number; feeSpendCents: number }): number {
  const spend = c.amountCents + Math.max(0, c.tipCents);
  if (spend <= 0 || c.feeSpendCents <= 0) return 0;
  const part = Math.round((c.amountCents * Math.min(c.feeSpendCents, spend)) / spend);
  return Math.max(0, Math.min(c.amountCents, part));
}

type RawTx = Pick<Prisma.TransactionClient, '$queryRaw'>;

/** Saltos de la cadena de saldos sumados que se siguen como mucho (como walletCash). */
const MAX_MERGE_HOPS = 10;

/**
 * Las recargas del saldo y de los sumados a él: en efectivo (cada una con sus
 * anulaciones restadas) y con tarjeta (cobradas: también las devueltas, que
 * ya restaron del saldo). Con el saldo bloqueado y bypass de RLS (el grupo).
 */
export async function saldoCredits(tx: RawTx, walletId: string): Promise<SaldoCredit[]> {
  const rows = await tx.$queryRaw<Array<{ at: Date; cents: number | bigint; withFee: boolean }>>`
    WITH RECURSIVE chain AS (
      SELECT id, 0 AS hops FROM client_wallets WHERE id = ${walletId}::uuid
      UNION ALL
      SELECT w.id, c.hops + 1 FROM client_wallets w JOIN chain c ON w."mergedIntoId" = c.id
       WHERE c.hops < ${MAX_MERGE_HOPS}
    )
    SELECT t."createdAt" AS at,
           (t."amountCents" + COALESCE((SELECT SUM(v."amountCents") FROM wallet_cash_topups v WHERE v."voidOfId" = t.id), 0))::int AS cents,
           (t."serviceFeeBps" IS NOT NULL) AS "withFee"
      FROM wallet_cash_topups t
     WHERE t."walletId" IN (SELECT id FROM chain) AND t."voidOfId" IS NULL
    UNION ALL
    SELECT COALESCE(p."authorizedAt", p."createdAt") AS at, p."amountCents" AS cents, (p."serviceFeeBps" IS NOT NULL) AS "withFee"
      FROM payments p
     WHERE p."walletId" IN (SELECT id FROM chain)
       AND p.status IN ('AUTHORIZED'::"PaymentStatus", 'PARTIALLY_REFUNDED'::"PaymentStatus", 'REFUNDED'::"PaymentStatus")
  `;
  return rows.map((r) => ({ at: new Date(r.at), cents: Number(r.cents), withServiceFee: r.withFee === true }));
}
