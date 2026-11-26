import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { TransactionalClient } from '../../common/prisma/prisma.service';
import { eur } from '../../common/money/eur';

/**
 * Una devolución pedida desde el panel lleva una clave por intención: la
 * genera la pantalla y la repite mientras no sepa en qué quedó (se cortó la
 * red, doble clic, recarga de la pestaña). Con la misma clave, el servidor
 * devuelve lo que pasó la primera vez en vez de devolver otra vez. Dos
 * devoluciones parciales a propósito llevan claves distintas.
 */
export type RefundIntention = { paymentId: string; amountCents: number; reason?: string; idempotencyKey?: string };

export const REFUND_KEY_REUSED_CODE = 'REFUND_KEY_REUSED';

/**
 * Huella de la intención: el cobro, el importe y quién la pide. El motivo no
 * cuenta (corregir una falta al reintentar no es otra devolución).
 */
export function refundIntent(request: RefundIntention, actor: { userId: string }): string {
  return createHash('sha256')
    .update(JSON.stringify({ v: 1, paymentId: request.paymentId, amountCents: request.amountCents, by: actor.userId }))
    .digest('hex');
}

/** 409 si la clave ya es de otra intención (otro cobro, otro importe u otra persona). */
export function assertRefundIntent(
  stored: string | null | undefined,
  request: RefundIntention,
  actor: { userId: string },
  original: { amountCents: number },
): void {
  if (stored === refundIntent(request, actor)) return;
  throw new ConflictException({
    message:
      `Con esta solicitud ya se pidió otra devolución (${eur(original.amountCents)}). ` +
      'Mira las devoluciones del cobro antes de pedir otra.',
    code: REFUND_KEY_REUSED_CODE,
  });
}

/** Mismo candado para la devolución directa y para pedirla al dueño (también entre cobros distintos). */
export async function lockRefundIntent(tx: TransactionalClient, tenantId: string, key: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`refund-intent:${tenantId}:${key}`}, 0))`;
}

/** La clave de la solicitud al dueño (no choca con las de «Marcar pagado»). */
export const refundApprovalKey = (key: string) => `refund:${key}`;

/** La solicitud al dueño hecha con esta clave (409 si es de otra intención). */
export async function findRefundApproval(tx: TransactionalClient, request: RefundIntention, actor: { tenantId: string; userId: string }) {
  if (!request.idempotencyKey) return null;
  const row = await tx.approvalRequest.findFirst({
    where: { tenantId: actor.tenantId, idempotencyKey: refundApprovalKey(request.idempotencyKey) },
  });
  if (row) assertRefundIntent(row.kind === 'REFUND' ? row.idempotencyHash : null, request, actor, row);
  return row;
}
