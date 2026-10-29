import { Inject, Injectable } from '@nestjs/common';
import { formatChargeRef, paymentMethodsOf } from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { saldoPayTokenOf } from './pay-redirect';
import { payStatusView, type PayStatusView } from './pay-status';
import type { PaymentMachineState } from './payment.machine';

/** Lo que necesita «Comprobando el pago»: su estado y, para pintarla, lo demás del cobro. */
export interface PayStatusContext {
  view: PayStatusView;
  qrToken: string;
  currency: string;
  /** El concepto del cobro (servicio de la carta), si lo hay. */
  concept: string | null;
  /** Referencia corta (C-0012), si la tiene. */
  ref: string | null;
  /** Cobro único que se puede pagar con el saldo: su enlace /s (null si no). */
  saldoPayToken: string | null;
}

const SELECT = {
  status: true,
  provider: true,
  amountCents: true,
  serviceFeeCents: true,
  tipCents: true,
  currency: true,
  qrToken: true,
  qrExpiresAt: true,
  updatedAt: true,
  ref: true,
  serviceName: true,
  venue: { select: { name: true, paymentMethods: true } },
  attempts: {
    orderBy: { createdAt: 'desc' as const },
    select: { providerTxId: true, status: true, createdAt: true, claimHash: true, amountCents: true },
  },
  linkedWalletCharge: { select: { payToken: true, status: true, expiresAt: true } },
} as const;

/**
 * El estado del pago para la página «Comprobando el pago» (pay-status.ts),
 * por el QR (/pay/:token) o por el pedido del banco (/pay/result?op=). Sin
 * login, con el bypass (como el resto de las páginas del cliente): el token y
 * el pedido son secretos de un solo cobro.
 */
@Injectable()
export class PayStatusService {
  private readonly prisma: PrismaService;

  constructor(@Inject(PrismaService) prisma: PrismaService) {
    this.prisma = prisma;
  }

  /** Por el QR. `viewerClaimHash`: la huella de la cookie de este navegador (null si no tiene). */
  async byToken(qrToken: string, viewerClaimHash: string | null, now: Date = new Date()): Promise<PayStatusContext | null> {
    const payment = await this.prisma.asSystem((tx) => tx.payment.findUnique({ where: { qrToken }, select: SELECT }));
    return payment ? contextOf(payment, { viewerClaimHash, now }) : null;
  }

  /** Por el pedido del banco al que vuelve el cliente (Ds_Order): es su intento (nunca «otro paga»). */
  async byOrder(order: string, now: Date = new Date()): Promise<PayStatusContext | null> {
    if (!order) return null;
    const payment = await this.prisma.asSystem(async (tx) => {
      const attempt = await tx.paymentAttempt.findFirst({ where: { providerTxId: order }, select: { paymentId: true } });
      return tx.payment.findFirst({ where: attempt ? { id: attempt.paymentId } : { providerTxId: order }, select: SELECT });
    });
    if (!payment) return null;
    const own = payment.attempts.find((a) => a.providerTxId === order);
    return contextOf(payment, { ownAttemptStatus: own?.status ?? null, now });
  }
}

type Row = {
  status: string;
  provider: string | null;
  amountCents: number;
  serviceFeeCents: number;
  tipCents: number;
  currency: string;
  qrToken: string;
  qrExpiresAt: Date;
  updatedAt: Date;
  ref: number | null;
  serviceName: string | null;
  venue: { name: string; paymentMethods: unknown } | null;
  attempts: Array<{ status: string; createdAt: Date; claimHash: string | null; amountCents: number | null }>;
  linkedWalletCharge: { payToken: string | null; status: string; expiresAt: Date } | null;
};

function contextOf(
  p: Row,
  who: { viewerClaimHash?: string | null; ownAttemptStatus?: string | null; now: Date },
): PayStatusContext {
  const saldo = p.linkedWalletCharge ? { ...p.linkedWalletCharge, enabled: paymentMethodsOf(p.venue?.paymentMethods).wallet } : null;
  return {
    view: payStatusView({
      status: p.status as PaymentMachineState,
      provider: p.provider,
      amountCents: p.amountCents,
      serviceFeeCents: p.serviceFeeCents,
      tipCents: p.tipCents,
      qrExpiresAt: p.qrExpiresAt,
      updatedAt: p.updatedAt,
      venueName: p.venue?.name ?? null,
      attempts: p.attempts,
      ...('viewerClaimHash' in who ? { viewerClaimHash: who.viewerClaimHash } : {}),
      ...(who.ownAttemptStatus !== undefined ? { ownAttemptStatus: who.ownAttemptStatus } : {}),
      now: who.now,
    }),
    qrToken: p.qrToken,
    currency: p.currency,
    concept: p.serviceName,
    ref: formatChargeRef(p.ref),
    saldoPayToken: saldoPayTokenOf({ saldo }, who.now),
  };
}
