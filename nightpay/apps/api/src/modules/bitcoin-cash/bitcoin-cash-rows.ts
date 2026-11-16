import type { TransactionalClient } from '../../common/prisma/prisma.service';
import type { TimeWindow } from '../reports/report-period';

/** Lo pagado con bitcoin y devuelto en efectivo en un periodo: sale de la caja. */
export interface BitcoinCashOut {
  count: number;
  cents: number;
}

export const NO_BITCOIN_CASH_OUT: BitcoinCashOut = { count: 0, cents: 0 };

/**
 * Las devoluciones en efectivo de cobros pagados con bitcoin (refunds con
 * paidInCash) y el bitcoin sin cobro devuelto en efectivo (btc_cash_returns),
 * por la fecha en que se dieron. Con `asOf` (un Z), solo lo apuntado antes.
 * Dentro de una transacción del local (btc_cash_returns tiene FORCE RLS).
 */
export async function bitcoinCashOut(
  tx: Pick<TransactionalClient, '$queryRaw'>,
  tenantId: string,
  w: TimeWindow,
  asOf?: Date,
): Promise<BitcoinCashOut> {
  const until = asOf && asOf.getTime() < w.to.getTime() ? asOf : w.to;
  const rows = await tx.$queryRaw<Array<{ count: number; cents: bigint | number }>>`
    SELECT COUNT(*)::int AS count, COALESCE(SUM(x."amountCents"), 0)::bigint AS cents
      FROM (
        SELECT r."amountCents" FROM refunds r
         WHERE r."tenantId" = ${tenantId}::uuid AND r."paidInCash" AND r.status = 'SUCCEEDED'
           AND r."createdAt" >= ${w.from} AND r."createdAt" < ${until}
        UNION ALL
        SELECT c."amountCents" FROM btc_cash_returns c
         WHERE c."tenantId" = ${tenantId}::uuid
           AND c."createdAt" >= ${w.from} AND c."createdAt" < ${until}
      ) x
  `;
  const r = rows[0];
  return r ? { count: Number(r.count), cents: Number(r.cents) } : NO_BITCOIN_CASH_OUT;
}
