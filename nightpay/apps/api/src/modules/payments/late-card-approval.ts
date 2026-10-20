import type { Logger } from '@nestjs/common';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { GatewayAdapter } from '../gateways/gateway.adapter';
import { PAID_WITH_SALDO_EVENT } from './cobro-link';

/**
 * Cobro único (cobro-link.ts): el banco aprueba la tarjeta DESPUÉS de que el
 * cliente pagara el mismo cobro con su saldo. El cobro con tarjeta ya estaba
 * CANCELED (no se puede dar por pagado): el cliente ha pagado dos veces.
 *
 *  - Si la pasarela devuelve por API, se devuelve el cargo de la tarjeta ya
 *    (idempotente por la referencia: un aviso repetido no devuelve dos veces)
 *    y queda apuntado (CARD_REFUNDED_AFTER_SALDO_EVENT, sin incidencia).
 *  - Si no puede (Redsys: se devuelve desde el portal del banco), o la
 *    devolución no se confirma, queda una incidencia clara para el dueño:
 *    «Cobrado dos veces: con el saldo y con la tarjeta» (approval_unbooked con
 *    reason paid_with_saldo), con el pedido y el importe a devolver.
 */

/** La devolución automática del cargo de la tarjeta salió bien (informativo). */
export const CARD_REFUNDED_AFTER_SALDO_EVENT = 'payment.card_refunded_after_saldo';
/** La misma incidencia que una aprobación que no se pudo apuntar, con su porqué. */
export const APPROVAL_UNBOOKED_EVENT = 'payment.approval_unbooked';
export const PAID_WITH_SALDO_REASON = 'paid_with_saldo';

export interface LateApprovalTarget {
  id: string;
  tenantId: string;
  amountCents: number;
}

export interface LateApprovalOutcome {
  /** Qué payment_event apuntar (y con qué datos). */
  eventType: typeof CARD_REFUNDED_AFTER_SALDO_EVENT | typeof APPROVAL_UNBOOKED_EVENT;
  payload: Record<string, unknown>;
}

/** ¿Se canceló este cobro con tarjeta porque lo pagó su saldo? */
export async function wasPaidWithSaldo(prisma: PrismaService, paymentId: string): Promise<boolean> {
  const n = await prisma.asSystem((tx) =>
    tx.paymentEvent.count({ where: { paymentId, eventType: PAID_WITH_SALDO_EVENT } }),
  );
  return n > 0;
}

/** ¿Ya se trató esta aprobación tardía (devuelta o en Incidencias)? Avisos repetidos, conciliación… */
export async function lateApprovalHandled(prisma: PrismaService, paymentId: string, providerTxId: string): Promise<boolean> {
  const events = await prisma.asSystem((tx) =>
    tx.paymentEvent.findMany({
      where: { paymentId, eventType: { in: [CARD_REFUNDED_AFTER_SALDO_EVENT, APPROVAL_UNBOOKED_EVENT] } },
      select: { payload: true },
    }),
  );
  return events.some((e) => (e.payload as Record<string, unknown> | null)?.providerTxId === providerTxId);
}

/**
 * Devuelve el cargo de la tarjeta si la pasarela puede; si no, la incidencia.
 * No escribe nada: quien llama apunta el evento (el aviso lo hace en la misma
 * transacción en la que lo da por procesado).
 */
export async function settleLateCardApproval(
  deps: { prisma: PrismaService; adapter: GatewayAdapter; logger: Pick<Logger, 'error' | 'warn' | 'log'> },
  target: LateApprovalTarget,
  providerTxId: string,
): Promise<LateApprovalOutcome> {
  const { prisma, adapter, logger } = deps;
  const attempt = await prisma.asSystem((tx) =>
    tx.paymentAttempt.findFirst({
      where: { paymentId: target.id, provider: adapter.provider, providerTxId },
      select: { amountCents: true },
    }),
  );
  // Lo que cobró el banco en ese pedido (importe + propina) o, sin intento, el del cobro.
  const amountCents = attempt?.amountCents ?? target.amountCents;
  const base = { provider: adapter.provider, providerTxId, amountCents };
  let refundError: string | null = null;
  try {
    const refund = await adapter.refund({
      tenantId: target.tenantId,
      paymentId: target.id,
      providerTxId,
      amountCents,
      reason: 'Pagado ya con el saldo OxioCard',
      reference: `saldo-${providerTxId}`.slice(0, 64),
    });
    if (refund.status === 'SUCCEEDED') {
      logger.log(`Cobro ${target.id}: la tarjeta (pedido ${providerTxId}) se aprobó tras pagar con saldo — devuelta sola`);
      return {
        eventType: CARD_REFUNDED_AFTER_SALDO_EVENT,
        payload: { ...base, providerRefundId: refund.providerRefundId },
      };
    }
    refundError = refund.status === 'PENDING' ? 'refund-pending' : 'refund-failed';
  } catch (err) {
    refundError = (err as Error).message || 'refund-error';
  }
  logger.error(
    `COBRADO DOS VECES cobro=${target.id}: pagado con saldo y la tarjeta (pedido ${providerTxId}) también. No se pudo devolver solo (${refundError}): queda en Incidencias.`,
  );
  return {
    eventType: APPROVAL_UNBOOKED_EVENT,
    payload: { ...base, fromStatus: 'CANCELED', reason: PAID_WITH_SALDO_REASON, refundError },
  };
}
