import type { TransactionalClient } from '../../common/prisma/prisma.service';
import { PAID_STATES } from './pay-redirect';
import type { PaymentMachineState } from './payment.machine';

/**
 * Doble cobro: el banco aprueba otro pedido (intento) de un cobro que ya
 * estaba pagado. Lo usa transition(), con la fila del cobro bloqueada, para
 * que dos aprobaciones a la vez no se den las dos por buenas sin incidencia.
 */

export const DUPLICATE_CHARGE_EVENT = 'payment.duplicate_charge';

interface ApprovalEvent {
  provider: string;
  providerTxId: string;
}

/** ¿Una aprobación de otro pedido, con el cobro ya pagado por la misma pasarela? */
export function isOtherOrder(
  p: { status: PaymentMachineState; provider: string | null; providerTxId: string | null },
  event: ApprovalEvent,
): boolean {
  return (
    PAID_STATES.has(p.status) &&
    p.provider === event.provider &&
    p.providerTxId !== null &&
    p.providerTxId !== event.providerTxId
  );
}

/** El intento de ese pedido pasa a APPROVED (sin tocar uno que ya lo esté). */
export async function markAttemptApproved(
  tx: TransactionalClient,
  paymentId: string,
  event: ApprovalEvent,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE payment_attempts
       SET status = 'APPROVED', "updatedAt" = NOW()
     WHERE "paymentId" = ${paymentId}::uuid
       AND provider = ${event.provider}::"Provider"
       AND "providerTxId" = ${event.providerTxId}
       AND status <> 'APPROVED'
  `;
}

/**
 * Apunta la segunda aprobación: intento APPROVED y una incidencia
 * payment.duplicate_charge (una por pedido, aunque el aviso se repita).
 * Devuelve null si ese pedido no es un intento de este cobro (no se sabe si
 * es otro cargo: sigue el camino de siempre), true si se apuntó ahora y false
 * si ya estaba apuntada.
 */
export async function recordSecondApproval(
  tx: TransactionalClient,
  p: { id: string; tenantId: string; providerTxId: string | null },
  event: ApprovalEvent,
  traceId: string,
): Promise<boolean | null> {
  const rows = await tx.$queryRaw<Array<{ isAttempt: boolean; recorded: boolean }>>`
    SELECT EXISTS (SELECT 1 FROM payment_attempts a
                    WHERE a."paymentId" = ${p.id}::uuid
                      AND a.provider = ${event.provider}::"Provider"
                      AND a."providerTxId" = ${event.providerTxId}) AS "isAttempt",
           EXISTS (SELECT 1 FROM payment_events e
                    WHERE e."paymentId" = ${p.id}::uuid
                      AND e."eventType" = ${DUPLICATE_CHARGE_EVENT}
                      AND e.payload ->> 'order' = ${event.providerTxId}) AS "recorded"
  `;
  const row = rows[0];
  if (!row?.isAttempt) return null;
  await markAttemptApproved(tx, p.id, event);
  if (row.recorded) return false;
  const payload = { order: event.providerTxId, provider: event.provider, chargedOrder: p.providerTxId };
  await tx.$executeRaw`
    INSERT INTO payment_events ("paymentId", "tenantId", "eventType", payload, "traceId")
    VALUES (${p.id}::uuid, ${p.tenantId}::uuid, ${DUPLICATE_CHARGE_EVENT}, ${JSON.stringify(payload)}::jsonb, ${traceId})
  `;
  return true;
}
