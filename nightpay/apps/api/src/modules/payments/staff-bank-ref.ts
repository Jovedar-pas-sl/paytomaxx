import { NotFoundException } from '@nestjs/common';
import { formatChargeRef } from '@nightpay/contracts';
import type { PrismaService } from '../../common/prisma/prisma.service';

export interface StaffBankRef {
  /** Referencia corta del cobro (C-0012); null en los antiguos. */
  ref: string | null;
  /** Pedido del banco (Ds_Order) del último intento, para buscarlo en el portal; null si no fue al banco. */
  order: string | null;
}

type Actor = { userId: string; role: string; tenantId: string };

/** Ven los de todo el local; el resto, solo los suyos. */
const VENUE_WIDE = new Set(['OWNER', 'MANAGER']);

/** El pedido del banco solo hace falta mientras el banco no ha contestado (o no lo ha confirmado). */
const WAITING_FOR_BANK = new Set(['AUTHORIZING', 'ORPHAN']);

/**
 * La referencia de un cobro que el banco no ha confirmado (ORPHAN), para la
 * pantalla «El banco no lo ha confirmado» del personal: la corta y el pedido
 * del banco, con los que el encargado lo busca en el portal y lo resuelve.
 * Solo del local de quien pregunta; la chica y el camarero, solo de los suyos
 * (un cobro de otro, como si no existiera). El pedido, solo con el cobro
 * esperando al banco o sin confirmar (después ya no hace falta). Nada de la
 * tarjeta.
 */
export async function staffBankRef(prisma: PrismaService, paymentId: string, actor: Actor): Promise<StaffBankRef> {
  const payment = await prisma.asSystem((tx) =>
    tx.payment.findFirst({
      where: { id: paymentId, tenantId: actor.tenantId },
      select: {
        ref: true,
        status: true,
        createdByUserId: true,
        providerTxId: true,
        attempts: { orderBy: { createdAt: 'desc' }, take: 1, select: { providerTxId: true } },
      },
    }),
  );
  if (!payment) throw new NotFoundException('Cobro no encontrado');
  if (!VENUE_WIDE.has(actor.role) && payment.createdByUserId !== actor.userId) throw new NotFoundException('Cobro no encontrado');
  return {
    ref: formatChargeRef(payment.ref),
    order: WAITING_FOR_BANK.has(payment.status) ? (payment.attempts[0]?.providerTxId ?? payment.providerTxId ?? null) : null,
  };
}
