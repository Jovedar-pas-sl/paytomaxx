import { ConflictException } from '@nestjs/common';
import type { CreatePayoutDto } from '@nightpay/contracts';
import type { TransactionalClient } from '../../common/prisma/prisma.service';
import { idempotencyHashOf } from '../payments/idempotency';

/**
 * Idempotency-Key de «Marcar pagado» (POST /admin/operators/:id/payouts),
 * como la de POST /payments: la misma clave con la misma petición de la
 * misma persona devuelve el mismo pago (se cortó la red, doble clic); con
 * otra chica, otra persona u otra petición, 409. Se guarda en el pago
 * (operator_payouts.idempotencyKey, único por local).
 */

export interface PayoutIdempotency {
  key: string;
  hash: string;
}

/** Lo que devuelve un pago apuntado (el mismo al repetirlo). */
export interface PayoutCreatedView {
  id: string;
  totalCents: number;
  earningCount: number;
  createdAt: string;
}

export const PAYOUT_KEY_REUSED_CODE = 'IDEMPOTENCY_KEY_REUSED';

/** Huella de quién paga y qué pide. Sin el código 2FA: cambia cada 30 s y el reintento lleva otro. */
export function payoutRequestHash(paidByUserId: string, operatorId: string, dto: CreatePayoutDto): string {
  const { totpCode: _totp, ...request } = dto;
  return idempotencyHashOf(paidByUserId, { operatorId, ...request });
}

export function payoutKeyReused(): ConflictException {
  return new ConflictException({
    message: 'Esa Idempotency-Key ya se usó para otro pago: vuelve a abrir el pago y pruébalo otra vez.',
    code: PAYOUT_KEY_REUSED_CODE,
  });
}

/** El pago ya apuntado con esta clave (null si no hay). 409 si es de otra petición. */
export async function replayPayout(
  tx: TransactionalClient,
  input: { tenantId: string; operatorId: string; paidByUserId: string; idempotency: PayoutIdempotency },
): Promise<PayoutCreatedView | null> {
  const prior = await tx.operatorPayout.findFirst({
    where: { tenantId: input.tenantId, idempotencyKey: input.idempotency.key },
    select: { id: true, operatorId: true, paidByUserId: true, idempotencyHash: true, totalCents: true, createdAt: true },
  });
  if (!prior) return null;
  const same =
    prior.operatorId === input.operatorId &&
    prior.paidByUserId === input.paidByUserId &&
    prior.idempotencyHash === input.idempotency.hash;
  if (!same) throw payoutKeyReused();
  const earningCount = await tx.operatorEarning.count({ where: { payoutId: prior.id } });
  return { id: prior.id, totalCents: prior.totalCents, earningCount, createdAt: prior.createdAt.toISOString() };
}
