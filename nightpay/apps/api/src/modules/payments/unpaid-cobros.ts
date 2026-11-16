import { formatChargeRef } from '@nightpay/contracts';
import type { PrismaService } from '../../common/prisma/prisma.service';
import { isHeldOnReader } from './reader-hold';

/** Sin pagar: el QR o el datáfono esperando, o el cliente en su banco (o pagando con bitcoin). */
export const UNPAID_STATUSES = ['CREATED', 'AWAITING_CAPTURE', 'AUTHORIZING'] as const;
const LIMIT = 50;

export interface UnpaidCobro {
  id: string;
  /** «C-0017» (los cobros antiguos no tienen). */
  ref: string | null;
  /** Lo que paga el cliente: importe + comisión del servicio + propina. */
  totalCents: number;
  status: (typeof UNPAID_STATUSES)[number];
  createdAt: string;
  /** Quién lo creó (el personal del local). */
  createdByName: string;
  /** Lo creó quien mira. */
  mine: boolean;
  /** El cliente está en la página de su banco: si lo termina, el pago entra igual (y queda en Incidencias). */
  atBank: boolean;
  /** Pagando con bitcoin (la factura abierta). */
  bitcoin: boolean;
  /**
   * Recarga cobrada en el datáfono sin comprobar (reader-hold.ts): la tarjeta
   * ya pagó. No se cancela (409 CANCEL_HELD_ON_READER); la resuelven en el panel.
   */
  heldOnReader: boolean;
}

/**
 * «Cobros» de la app del personal → «Sin pagar en el local»: los cobros sin
 * pagar de todo el local, para cancelar también los de otra persona (decisión
 * del dueño: cualquiera del personal cancela cualquier cobro sin pagar). Solo
 * lo justo para reconocerlo: referencia, importe, hora y quién lo creó. Un QR
 * caducado sin empezar ya no sale (se cierra solo). La recarga cobrada en el
 * datáfono sin comprobar sí sale, pero sin poder cancelarla.
 */
export async function listUnpaidCobros(
  prisma: PrismaService,
  input: { tenantId: string; userId: string; now?: Date },
): Promise<UnpaidCobro[]> {
  const now = input.now ?? new Date();
  const rows = await prisma.payment.findMany({
    where: {
      tenantId: input.tenantId,
      status: { in: [...UNPAID_STATUSES] },
      OR: [{ status: 'AUTHORIZING' }, { qrExpiresAt: { gt: now } }],
    },
    orderBy: { createdAt: 'desc' },
    take: LIMIT,
    select: {
      id: true,
      ref: true,
      status: true,
      provider: true,
      posOperationNumber: true,
      amountCents: true,
      serviceFeeCents: true,
      tipCents: true,
      createdAt: true,
      createdByUserId: true,
      createdBy: { select: { displayName: true } },
    },
  });
  return rows.map((p) => {
    // Cobrada en el datáfono y sin comprobar: ni «en su banco» ni cancelable.
    const heldOnReader = isHeldOnReader(p);
    return {
      id: p.id,
      ref: formatChargeRef(p.ref),
      totalCents: p.amountCents + p.serviceFeeCents + p.tipCents,
      status: p.status as UnpaidCobro['status'],
      createdAt: p.createdAt.toISOString(),
      createdByName: p.createdBy?.displayName?.trim() || 'El cliente, desde su móvil',
      mine: p.createdByUserId === input.userId,
      atBank: !heldOnReader && p.status === 'AUTHORIZING' && p.provider !== 'BTCPAY',
      bitcoin: p.status === 'AUTHORIZING' && p.provider === 'BTCPAY',
      heldOnReader,
    };
  });
}
