import type { TransactionalClient } from '../../common/prisma/prisma.service';
import { WALLET_CREDITED_EVENT } from '../payments/payment-device';
import { applyPaid, commissionDue, promoterCommissionCents } from './reservation-rules';

/**
 * Lo pagado de una reserva, apuntado en la misma transacción que mueve el
 * dinero, una vez (paidAt):
 *  - con tarjeta: en la transición del cobro a AUTHORIZED (aviso firmado del
 *    banco; PaymentsService.transition, con el cobro bloqueado). Solo si la
 *    recarga llegó de verdad al saldo del grupo;
 *  - en efectivo (el resto en la puerta o en recepción): en la transacción de
 *    la recarga en efectivo del saldo del grupo (entra en la caja de la noche).
 *
 * Suma lo pagado y pone el estado (Señal pagada / Pagado). Con el paquete
 * pagado entero y vendido por un RRPP (si el local no le quitó la comisión):
 * su comisión, una ganancia más de la persona que cobra en el reparto de
 * siempre. Si ya no cabe (anulada, ya pagada o de más): incidencia; el dinero
 * está en el saldo del grupo. SQL crudo, como el resto de transition().
 */

interface LockedReservation {
  id: string;
  status: string;
  priceCents: number;
  depositCents: number;
  paidCents: number;
  promoterId: string | null;
  promoterBps: number | null;
  commissionEarnedAt: Date | null;
  commissionVoidedAt: Date | null;
}

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
  // Solo si la recarga llegó de verdad al saldo del grupo (si estaba cerrado, la
  // transición ya abrió su incidencia: cobrado y sin saldo).
  const credited = await tx.$queryRaw<Array<{ walletId: string | null }>>`
    SELECT payload->>'walletId' AS "walletId" FROM payment_events
     WHERE "paymentId" = ${p.id}::uuid AND "eventType" = ${WALLET_CREDITED_EVENT}
     ORDER BY "occurredAt" DESC LIMIT 1
  `;
  await applyToReservation(tx, {
    tenantId: p.tenantId,
    linkId: link.id,
    reservationId: link.reservationId,
    kind: link.kind,
    amountCents: p.amountCents,
    walletId: credited[0]?.walletId ?? null,
    earningPaymentId: p.id,
    source: { paymentId: p.id },
    traceId,
  });
}

/** El resto pagado en efectivo (ya sumado al saldo del grupo en esta misma transacción). */
export async function applyReservationCash(
  tx: TransactionalClient,
  c: { tenantId: string; linkId: string; reservationId: string; amountCents: number; walletId: string; cashTopUpId: string },
): Promise<void> {
  // La comisión del RRPP va en el primer pago con tarjeta de la reserva (la señal).
  const first = await tx.$queryRaw<Array<{ paymentId: string }>>`
    SELECT "paymentId" FROM reservation_payments
     WHERE "reservationId" = ${c.reservationId}::uuid AND "paymentId" IS NOT NULL AND "paidAt" IS NOT NULL
     ORDER BY "paidAt" ASC LIMIT 1
  `;
  await applyToReservation(tx, {
    tenantId: c.tenantId,
    linkId: c.linkId,
    reservationId: c.reservationId,
    kind: 'REST',
    amountCents: c.amountCents,
    walletId: c.walletId,
    earningPaymentId: first[0]?.paymentId ?? null,
    source: { cashTopUpId: c.cashTopUpId },
  });
}

async function applyToReservation(
  tx: TransactionalClient,
  a: {
    tenantId: string;
    linkId: string;
    reservationId: string;
    kind: string;
    amountCents: number;
    walletId: string | null;
    earningPaymentId: string | null;
    source: Record<string, string>;
    traceId?: string;
  },
): Promise<void> {
  const rows = await tx.$queryRaw<LockedReservation[]>`
    SELECT id, status, "priceCents", "depositCents", "paidCents", "promoterId", "promoterBps", "commissionEarnedAt", "commissionVoidedAt"
      FROM reservations WHERE id = ${a.reservationId}::uuid FOR UPDATE
  `;
  const r = rows[0];
  if (!r) return;
  await tx.$executeRaw`UPDATE reservation_payments SET "paidAt" = now() WHERE id = ${a.linkId}::uuid`;
  const outcome = a.walletId ? applyPaid(r, a.amountCents) : ({ ok: false, reason: 'not_credited' } as const);
  if (!outcome.ok) {
    await audit(tx, a.tenantId, 'reservation.payment_unapplied', r.id, {
      ...a.source,
      walletId: a.walletId,
      amountCents: a.amountCents,
      kind: a.kind,
      status: r.status,
      reason: outcome.reason,
    }, a.traceId);
    return;
  }
  await tx.$executeRaw`
    UPDATE reservations
       SET "paidCents" = ${outcome.paidCents}::int,
           status = ${outcome.status},
           "walletId" = COALESCE("walletId", ${a.walletId}::uuid),
           "updatedAt" = now()
     WHERE id = ${r.id}::uuid
  `;
  await audit(tx, a.tenantId, 'reservation.paid', r.id, { ...a.source, kind: a.kind, amountCents: a.amountCents, paidCents: outcome.paidCents }, a.traceId);
  if (commissionDue({ ...r, paidCents: outcome.paidCents }) && r.promoterId && a.earningPaymentId) {
    await earnCommission(tx, { ...r, promoterId: r.promoterId }, { id: a.earningPaymentId, tenantId: a.tenantId }, a.traceId);
  }
}

/** La comisión del RRPP con el paquete pagado entero: una ganancia en un pago de la reserva. */
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

/**
 * El local cambió la fecha o anuló: el RRPP pierde la comisión, siempre. Si ya
 * estaba apuntada y sin pagar, se anula del reparto (su neto queda a 0); si ya
 * se le pagó, no se mueve dinero: queda el aviso al dueño (incidencia
 * promoter_commission_paid, con el importe y su nombre) para hablarlo con él.
 */
export async function voidPromoterCommission(tx: TransactionalClient, r: { id: string; tenantId: string; promoterId: string | null }, actorId: string): Promise<void> {
  if (!r.promoterId) return;
  const done = await tx.$executeRaw`
    UPDATE reservations SET "commissionVoidedAt" = now() WHERE id = ${r.id}::uuid AND "commissionVoidedAt" IS NULL
  `;
  if (done === 0) return;
  const earnings = await tx.$queryRaw<Array<{ id: string; commissionCents: number; payoutId: string | null }>>`
    SELECT e.id, e."commissionCents", e."payoutId"
      FROM operator_earnings e
      JOIN promoters pr ON pr.id = ${r.promoterId}::uuid AND pr."userId" = e."operatorId"
     WHERE e."paymentId" IN (SELECT "paymentId" FROM reservation_payments WHERE "reservationId" = ${r.id}::uuid AND "paymentId" IS NOT NULL)
     FOR UPDATE OF e
  `;
  const paid = earnings.some((e) => e.payoutId !== null) ? await promoterName(tx, r.promoterId) : null;
  for (const e of earnings) {
    if (e.payoutId === null) {
      await tx.$executeRaw`UPDATE operator_earnings SET "reversedCents" = "commissionCents" WHERE id = ${e.id}::uuid`;
    }
    await audit(tx, r.tenantId, e.payoutId === null ? 'reservation.commission_voided' : 'reservation.commission_voided_after_payout', r.id, {
      earningId: e.id,
      commissionCents: e.commissionCents,
      actorId,
      // Ya pagada: lo que lee el aviso al dueño (incidents: amountCents del registro).
      ...(e.payoutId === null ? {} : { amountCents: e.commissionCents, promoterName: paid }),
    });
  }
}

async function promoterName(tx: TransactionalClient, promoterId: string): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ name: string | null }>>`
    SELECT COALESCE(NULLIF(btrim(u."displayName"), ''), split_part(u.email, '@', 1)) AS name
      FROM promoters pr JOIN users u ON u.id = pr."userId"
     WHERE pr.id = ${promoterId}::uuid
  `;
  return rows[0]?.name ?? null;
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
