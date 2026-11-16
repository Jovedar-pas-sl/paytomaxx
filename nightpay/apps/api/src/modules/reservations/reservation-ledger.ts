import type { TransactionalClient } from '../../common/prisma/prisma.service';
import { WALLET_CREDITED_EVENT } from '../payments/payment-device';
import { applyPaid, commissionDue, promoterCommissionCents } from './reservation-rules';

/**
 * Un pago de una reserva aprobado por el banco: lo apunta en la reserva DENTRO
 * de la transacción de la transición del cobro a AUTHORIZED (PaymentsService.
 * transition, con el cobro bloqueado). Así nada se da por pagado sin el aviso
 * firmado del banco, y una sola vez (paidAt).
 *
 *  - suma lo pagado y pone el estado (Señal pagada / Pagado);
 *  - el saldo del grupo es el de la recarga (el primer pago lo crea);
 *  - con el paquete pagado entero y vendido por un RRPP: su comisión (su % del
 *    paquete) como una ganancia más de la persona, que cobra en el reparto de
 *    siempre (operator_earnings, una vez: commissionEarnedAt);
 *  - si ya no cabe (anulada, ya pagada o de más): incidencia en el registro; el
 *    dinero está en el saldo del grupo y el encargado lo devuelve desde Saldos.
 *
 * SQL crudo, como el resto de transition(): no depende del local del contexto.
 * No lanza por la reserva: un rollback dejaría el aviso del banco reintentando.
 */
export async function applyReservationPayment(
  tx: TransactionalClient,
  p: { id: string; tenantId: string; walletId: string | null; amountCents: number },
  traceId?: string,
): Promise<void> {
  // Los pagos de una reserva son siempre recargas del saldo del grupo.
  if (!p.walletId) return;
  const links = await tx.$queryRaw<Array<{ id: string; reservationId: string; kind: string; paidAt: Date | null }>>`
    SELECT id, "reservationId", kind, "paidAt" FROM reservation_payments WHERE "paymentId" = ${p.id}::uuid
  `;
  const link = links[0];
  if (!link || link.paidAt) return;
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      status: string;
      priceCents: number;
      depositCents: number;
      paidCents: number;
      promoterId: string | null;
      promoterBps: number | null;
      commissionEarnedAt: Date | null;
      walletId: string | null;
    }>
  >`
    SELECT id, status, "priceCents", "depositCents", "paidCents", "promoterId", "promoterBps", "commissionEarnedAt", "walletId"
      FROM reservations WHERE id = ${link.reservationId}::uuid FOR UPDATE
  `;
  const r = rows[0];
  if (!r) return;
  await tx.$executeRaw`UPDATE reservation_payments SET "paidAt" = now() WHERE id = ${link.id}::uuid`;
  // Solo si la recarga llegó de verdad al saldo del grupo (si estaba cerrado, la
  // transición ya abrió su incidencia: cobrado y sin saldo).
  const credited = await tx.$queryRaw<Array<{ walletId: string | null }>>`
    SELECT payload->>'walletId' AS "walletId" FROM payment_events
     WHERE "paymentId" = ${p.id}::uuid AND "eventType" = ${WALLET_CREDITED_EVENT}
     ORDER BY "occurredAt" DESC LIMIT 1
  `;
  const walletId = credited[0]?.walletId ?? null;
  const outcome = walletId ? applyPaid(r, p.amountCents) : ({ ok: false, reason: 'not_credited' } as const);
  if (!outcome.ok) {
    await audit(tx, p.tenantId, 'reservation.payment_unapplied', r.id, {
      paymentId: p.id,
      walletId: p.walletId,
      amountCents: p.amountCents,
      kind: link.kind,
      status: r.status,
      reason: outcome.reason,
    }, traceId);
    return;
  }
  await tx.$executeRaw`
    UPDATE reservations
       SET "paidCents" = ${outcome.paidCents}::int,
           status = ${outcome.status},
           "walletId" = COALESCE("walletId", ${walletId}::uuid),
           "updatedAt" = now()
     WHERE id = ${r.id}::uuid
  `;
  await audit(tx, p.tenantId, 'reservation.paid', r.id, { paymentId: p.id, kind: link.kind, amountCents: p.amountCents, paidCents: outcome.paidCents }, traceId);
  if (commissionDue({ ...r, paidCents: outcome.paidCents }) && r.promoterId) {
    await earnCommission(tx, { ...r, promoterId: r.promoterId }, p, traceId);
  }
}

/** La comisión del RRPP con el paquete pagado entero: una ganancia en el pago que lo completa. */
async function earnCommission(
  tx: TransactionalClient,
  r: { id: string; priceCents: number; promoterId: string; promoterBps: number | null },
  p: { id: string; tenantId: string },
  traceId?: string,
): Promise<void> {
  const promoter = await tx.$queryRaw<Array<{ userId: string }>>`SELECT "userId" FROM promoters WHERE id = ${r.promoterId}::uuid`;
  const userId = promoter[0]?.userId;
  const bps = r.promoterBps ?? 0;
  const commissionCents = promoterCommissionCents(r.priceCents, bps);
  if (userId && commissionCents > 0) {
    await tx.$executeRaw`
      INSERT INTO operator_earnings ("tenantId", "operatorId", "paymentId", "paymentAmountCents", "commissionBps", "commissionCents")
      VALUES (${p.tenantId}::uuid, ${userId}::uuid, ${p.id}::uuid, ${r.priceCents}::int, ${bps}::int, ${commissionCents}::int)
      ON CONFLICT DO NOTHING
    `;
  }
  await tx.$executeRaw`UPDATE reservations SET "commissionEarnedAt" = now() WHERE id = ${r.id}::uuid`;
  await audit(tx, p.tenantId, 'reservation.commission_earned', r.id, { paymentId: p.id, userId: userId ?? null, bps, commissionCents }, traceId);
}

async function audit(
  tx: TransactionalClient,
  tenantId: string,
  action: string,
  reservationId: string,
  payload: Record<string, unknown>,
  traceId?: string,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO audit_events ("tenantId", action, "targetType", "targetId", payload, "traceId", "occurredAt")
    VALUES (${tenantId}::uuid, ${action}, 'Reservation', ${reservationId}, ${JSON.stringify(payload)}::jsonb, ${traceId ?? null}, now())
  `;
}
