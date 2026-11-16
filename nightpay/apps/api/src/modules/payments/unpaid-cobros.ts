import { formatChargeRef } from '@nightpay/contracts';
import type { PrismaService } from '../../common/prisma/prisma.service';
import { bankVisitsSince, cancelWaitMsOf, isAtBank } from './cancel-at-bank';

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
  /** En su banco: desde cuándo (la hora de la base; null si no se sabe o no está en su banco). */
  atBankSince: string | null;
  /**
   * En su banco: lo que falta (ms, al responder) para poder cancelar (2 min
   * desde que salió al banco, cancel-at-bank.ts); 0 = ya se puede. Fuera del
   * banco, siempre 0.
   */
  cancelableInMs: number;
}

/**
 * «Cobros» de la app del personal → «Sin pagar en el local»: los cobros sin
 * pagar de todo el local, para cancelar también los de otra persona (decisión
 * del dueño: cualquiera del personal cancela cualquier cobro sin pagar; con el
 * cliente en su banco, pasados 2 minutos). Solo lo justo para reconocerlo:
 * referencia, importe, hora y quién lo creó. Un QR caducado sin empezar ya no
 * sale (se cierra solo).
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
      amountCents: true,
      serviceFeeCents: true,
      tipCents: true,
      createdAt: true,
      createdByUserId: true,
      createdBy: { select: { displayName: true } },
    },
  });
  // Desde cuándo está en su banco cada uno (una consulta para todos, con la hora de la base).
  const visits = await bankVisitsSince(
    prisma,
    input.tenantId,
    rows.filter((p) => isAtBank(p)).map((p) => p.id),
  );
  return rows.map((p) => {
    const atBank = isAtBank(p);
    return {
      id: p.id,
      ref: formatChargeRef(p.ref),
      totalCents: p.amountCents + p.serviceFeeCents + p.tipCents,
      status: p.status as UnpaidCobro['status'],
      createdAt: p.createdAt.toISOString(),
      createdByName: p.createdBy?.displayName?.trim() || 'El cliente, desde su móvil',
      mine: p.createdByUserId === input.userId,
      atBank,
      bitcoin: p.status === 'AUTHORIZING' && p.provider === 'BTCPAY',
      atBankSince: atBank ? (visits.since.get(p.id)?.toISOString() ?? null) : null,
      cancelableInMs: cancelWaitMsOf(p, visits),
    };
  });
}
