import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { TransactionalClient } from '../../common/prisma/prisma.service';

export type RefundIntention = { paymentId: string; amountCents: number; reason?: string; idempotencyKey?: string };

export function refundIntent(request: RefundIntention, actor: { userId: string }): string {
  return createHash('sha256').update(JSON.stringify([request.paymentId, request.amountCents, request.reason?.trim() || null, actor.userId])).digest('hex');
}

export function assertRefundIntent(stored: string | null | undefined, request: RefundIntention, actor: { userId: string }): void {
  if (stored !== refundIntent(request, actor)) {
    throw new ConflictException({ message: 'Esa clave de devolución ya se usó con otros datos. Empieza una devolución nueva.', code: 'REFUND_KEY_REUSED' });
  }
}

/** Same lock for API refunds and approval requests, including across payment ids. */
export async function lockRefundIntent(tx: TransactionalClient, tenantId: string, key: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`refund-intent:${tenantId}:${key}`}, 0))`;
}

export const refundApprovalKey = (key: string) => `refund:${key}`;

export async function findRefundApproval(tx: TransactionalClient, request: RefundIntention, actor: { tenantId: string; userId: string }) {
  if (!request.idempotencyKey) return null;
  const row = await tx.approvalRequest.findFirst({ where: { tenantId: actor.tenantId, idempotencyKey: refundApprovalKey(request.idempotencyKey) } });
  if (row) assertRefundIntent(row.kind === 'REFUND' ? row.idempotencyHash : null, request, actor);
  return row;
}
