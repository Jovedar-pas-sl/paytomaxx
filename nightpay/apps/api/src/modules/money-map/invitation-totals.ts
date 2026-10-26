import { Prisma } from '@nightpay/db';
import type { InvitationSummary } from '@nightpay/contracts';
import type { TransactionalClient } from '../../common/prisma/prisma.service';
import type { TimeWindow } from '../reports/report-period';
import { paymentAt } from '../reports/reporting-sql';

type Num = number | bigint | null;

/**
 * Las copas con invitación de una chica (su ficha en el panel, «Mi QR» y «Mi
 * noche»): cuántas, lo vendido (sus copas) y su parte. Con tarjeta, las
 * pagadas: una devuelta en parte sigue contando, con su parte menos lo
 * descontado (en la misma proporción que lo devuelto sobre lo cobrado, como
 * su ganancia: refund-share.ts, sobre lo cobrado con la «Comisión del servicio»);
 * una devuelta del todo, no. Del saldo, las
 * pagadas sin anular. Con `window`, las de esas fechas (la del banco o la del
 * consumo). En una transacción: payment_lines y los consumos tienen FORCE RLS.
 */
export async function invitationTotals(
  tx: TransactionalClient,
  tenantId: string,
  operatorId: string,
  window?: TimeWindow,
): Promise<InvitationSummary> {
  const card = window ? Prisma.sql`AND ${paymentAt('p')} >= ${window.from} AND ${paymentAt('p')} < ${window.to}` : Prisma.empty;
  const saldo = window ? Prisma.sql`AND c."createdAt" >= ${window.from} AND c."createdAt" < ${window.to}` : Prisma.empty;
  const rows = await tx.$queryRaw<Array<{ count: Num; amount: Num; share: Num }>>`
    SELECT COALESCE(SUM(x.count), 0)::bigint AS count,
           COALESCE(SUM(x.amount), 0)::bigint AS amount,
           COALESCE(SUM(x.share), 0)::bigint AS share
      FROM (
        SELECT SUM(l.qty) AS count,
               SUM(l."amountCents") AS amount,
               SUM(l."beneficiaryCents") - ROUND(
                 SUM(l."beneficiaryCents")::numeric
                 * LEAST(COALESCE(rf.refunded, 0), p."amountCents" + p."serviceFeeCents" + p."tipCents")
                 / NULLIF(p."amountCents" + p."serviceFeeCents" + p."tipCents", 0)
               ) AS share
          FROM payment_lines l
          JOIN payments p ON p.id = l."paymentId"
          LEFT JOIN LATERAL (
            SELECT SUM(r."amountCents") AS refunded
              FROM refunds r
             WHERE r."paymentId" = p.id AND r.status = 'SUCCEEDED'
          ) rf ON true
         WHERE l."tenantId" = ${tenantId}::uuid
           AND l."beneficiaryOperatorId" = ${operatorId}::uuid
           AND p.status::text IN ('AUTHORIZED', 'PARTIALLY_REFUNDED')
           ${card}
         GROUP BY p.id, p."amountCents", p."serviceFeeCents", p."tipCents", rf.refunded
        UNION ALL
        SELECT SUM(l.qty), SUM(l."amountCents"), SUM(l."beneficiaryCents")
          FROM payment_lines l
          JOIN wallet_charge_requests w ON w.id = l."walletChargeId"
          JOIN wallet_consumptions c ON c.id = w."consumptionId"
         WHERE l."tenantId" = ${tenantId}::uuid
           AND l."beneficiaryOperatorId" = ${operatorId}::uuid
           AND w.status = 'ACCEPTED'
           AND c."reversedAt" IS NULL
           ${saldo}
      ) x
  `;
  const r = rows[0];
  return { count: Number(r?.count ?? 0), amountCents: Number(r?.amount ?? 0), shareCents: Number(r?.share ?? 0) };
}
