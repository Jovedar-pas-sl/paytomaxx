import { ConflictException } from '@nestjs/common';
import type { TransactionalClient } from '../../common/prisma/prisma.service';

/**
 * Un hash on-chain solo vale para UN pago del local (antes el mismo hash
 * podía «verificar» varios pagos). Lo comprueba la API antes de llamar al
 * explorador y lo asegura el índice único parcial
 * operator_payouts_tenant_onchain_tx_key (migración 20261015040000).
 */
export async function otherPayoutWithTx(
  tx: TransactionalClient,
  tenantId: string,
  /** El pago que se está verificando (no cuenta); null al crearlo. */
  payoutId: string | null,
  externalTxId: string,
): Promise<{ id: string; createdAt: Date } | null> {
  return tx.operatorPayout.findFirst({
    where: {
      tenantId,
      ...(payoutId ? { id: { not: payoutId } } : {}),
      externalTxId: { equals: externalTxId, mode: 'insensitive' },
    },
    select: { id: true, createdAt: true },
  });
}

export function txAlreadyUsed(other?: { id: string; createdAt: Date } | null): ConflictException {
  const when = other ? ` (del ${other.createdAt.toISOString().slice(0, 10)})` : '';
  return new ConflictException({
    message: `Ese hash ya está apuntado en otro pago${when}: cada transacción solo vale para un pago.`,
    code: 'PAYOUT_TX_ALREADY_USED',
    ...(other ? { payoutId: other.id } : {}),
  });
}

/** Violación de índice único de Prisma (P2002). */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}
