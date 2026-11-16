import { randomUUID } from 'node:crypto';
import type { Logger } from '@nestjs/common';
import type { PrismaService } from '../../common/prisma/prisma.service';
import { APPROVAL_UNBOOKED_EVENT } from './late-card-approval';

/**
 * «Pagó después de cancelar»: el personal canceló un cobro (también con el
 * cliente en la página de su banco) y el banco lo cobró después.
 *
 *  - El cobro sigue CANCELED: nunca se devuelve solo ni pasa a pagado solo.
 *  - Queda UNA incidencia por pedido del banco (payment.approval_unbooked con
 *    reason paid_after_cancel), aunque el aviso se repita o llegue a la vez por
 *    la vuelta del cliente, el aviso del banco y la conciliación: se apunta con
 *    el cobro bloqueado (FOR UPDATE), mirando antes si ya está.
 *  - La ven el encargado y el dueño (panel → Avisos, y Telegram como los demás
 *    avisos de dinero) y recepción (app del personal → Incidencias).
 *  - Se cierra con una nota de qué se hizo (devuelto en el banco o dado por
 *    bueno). «Dar por bueno» (encargado o dueño, con 2FA) lo pasa a pagado.
 *  - El cliente, en su página, ve que se canceló pero su banco lo pagó.
 */
export const PAID_AFTER_CANCEL_REASON = 'paid_after_cancel';

export interface PaidAfterCancelTarget {
  id: string;
  tenantId: string;
  amountCents: number;
}

export interface PaidAfterCancelInput {
  provider: string | null;
  providerTxId: string;
  /** De dónde llegó: el aviso del banco (o la vuelta del cliente) o la conciliación. */
  source: 'aviso' | 'conciliacion';
  /** El aviso que lo trae: se da por procesado en la misma transacción. */
  deliveryId?: string;
}

/**
 * Apunta la incidencia (si no estaba ya para ese pedido). Devuelve true si la
 * apuntó ahora. No toca el estado del cobro ni devuelve nada.
 */
export async function recordPaidAfterCancel(
  deps: { prisma: PrismaService; logger: Pick<Logger, 'error'> },
  target: PaidAfterCancelTarget,
  input: PaidAfterCancelInput,
): Promise<boolean> {
  const recorded = await deps.prisma.asSystem(async (tx) => {
    // Con el cobro bloqueado: dos avisos del mismo pago a la vez se ponen en fila.
    await tx.$queryRaw`SELECT id FROM payments WHERE id = ${target.id}::uuid FOR UPDATE`;
    const already = await tx.$queryRaw<Array<{ one: number }>>`
      SELECT 1 AS one FROM payment_events
       WHERE "paymentId" = ${target.id}::uuid
         AND "eventType" = ${APPROVAL_UNBOOKED_EVENT}
         AND payload->>'providerTxId' = ${input.providerTxId}
       LIMIT 1
    `;
    let inserted = false;
    if (already.length === 0) {
      // Lo que cobró el banco en ese pedido (importe + comisión + propina) o, sin intento, el del cobro.
      const attempt = await tx.paymentAttempt.findFirst({
        where: { paymentId: target.id, providerTxId: input.providerTxId },
        select: { amountCents: true },
      });
      await tx.paymentEvent.create({
        data: {
          paymentId: target.id,
          tenantId: target.tenantId,
          eventType: APPROVAL_UNBOOKED_EVENT,
          payload: {
            provider: input.provider,
            providerTxId: input.providerTxId,
            amountCents: attempt?.amountCents ?? target.amountCents,
            fromStatus: 'CANCELED',
            reason: PAID_AFTER_CANCEL_REASON,
            source: input.source,
            ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
          },
          traceId: randomUUID(),
        },
      });
      inserted = true;
    }
    if (input.deliveryId) {
      await tx.webhookDelivery.update({ where: { id: BigInt(input.deliveryId) }, data: { processedAt: new Date() } });
    }
    return inserted;
  });
  if (recorded) {
    deps.logger.error(
      `PAGÓ DESPUÉS DE CANCELAR cobro=${target.id}: el banco cobró el pedido ${input.providerTxId} con el cobro ya cancelado. Sigue cancelado, sin devolver: queda en Incidencias.`,
    );
  }
  return recorded;
}

/** ¿El banco cobró este cobro cancelado? (para la página del cliente). */
export async function wasPaidAfterCancel(
  tx: Pick<Parameters<Parameters<PrismaService['asSystem']>[0]>[0], '$queryRaw'>,
  paymentId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ one: number }>>`
    SELECT 1 AS one FROM payment_events
     WHERE "paymentId" = ${paymentId}::uuid
       AND "eventType" = ${APPROVAL_UNBOOKED_EVENT}
       AND payload->>'reason' = ${PAID_AFTER_CANCEL_REASON}
     LIMIT 1
  `;
  return rows.length > 0;
}
