import { ConflictException } from '@nestjs/common';
import type { TransactionalClient } from '../../common/prisma/prisma.service';
import { pendingRefundApprovalCents } from '../approvals/approval-store';

/**
 * Piezas de las devoluciones que van DENTRO de una transacción con la fila
 * del cobro bloqueada (FOR UPDATE). Las dos vías (devolución por la pasarela
 * y devolución apuntada del banco) se ordenan con ese mismo candado, así que
 * lo que una reserva o descuenta lo ve siempre la otra.
 */

export const REFUNDABLE_STATUSES: ReadonlySet<string> = new Set(['AUTHORIZED', 'PARTIALLY_REFUNDED']);

/** Ventana en la que una devolución del banco del mismo importe se trata como posible repetida. */
const DUPLICATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Antes las devoluciones del banco pasaban un momento por PENDING. Una que se
 * quedó así por una caída (código antiguo) solo reserva unos minutos; las de
 * la pasarela reservan siempre hasta que se resuelven (pudo hacerse).
 */
const LEGACY_BANK_PENDING_MS = 15 * 60 * 1000;

export interface LockedRefundablePayment {
  availableAmountCents: number;
  status: string;
}

/** Bloquea la fila del cobro hasta el final de la transacción. */
export async function lockPaymentForRefund(
  tx: TransactionalClient,
  paymentId: string,
): Promise<LockedRefundablePayment | null> {
  const rows = await tx.$queryRaw<LockedRefundablePayment[]>`
    SELECT "availableAmountCents", status::text AS status
      FROM payments
     WHERE id = ${paymentId}::uuid
     FOR UPDATE
  `;
  return rows[0] ?? null;
}

/**
 * Lo que tienen reservado las devoluciones aún pendientes del cobro: no
 * cuentan todavía en availableAmountCents pero el dinero puede estar saliendo.
 * También lo pedido al dueño y aún sin decidir («Por aprobar»): al aprobarla,
 * la solicitud deja de reservar en la misma transacción en que se reserva la
 * devolución, así que nunca cuenta dos veces ni deja un hueco.
 */
export async function reservedRefundCents(
  tx: TransactionalClient,
  paymentId: string,
  now: Date = new Date(),
): Promise<number> {
  const agg = await tx.refund.aggregate({
    where: {
      paymentId,
      status: 'PENDING',
      OR: [{ registeredManually: false }, { createdAt: { gte: new Date(now.getTime() - LEGACY_BANK_PENDING_MS) } }],
    },
    _sum: { amountCents: true },
  });
  return (agg._sum.amountCents ?? 0) + (await pendingRefundApprovalCents(tx, paymentId, now));
}

/** Lo que aún se puede devolver: lo devolvible menos lo reservado. Si no cabe, 409. */
export async function assertRefundFits(
  tx: TransactionalClient,
  paymentId: string,
  locked: LockedRefundablePayment,
  amountCents: number,
): Promise<void> {
  const free = locked.availableAmountCents - (await reservedRefundCents(tx, paymentId));
  if (amountCents > free) {
    throw new ConflictException(`Solo quedan ${Math.max(0, free)} céntimos por devolver en este cobro`);
  }
}

/** Una devolución del banco igual en los últimos días: hay que confirmar que es otra. */
export async function assertNotDuplicateBankRefund(
  tx: TransactionalClient,
  paymentId: string,
  amountCents: number,
  message: string,
): Promise<void> {
  const similar = await tx.refund.count({
    where: {
      paymentId,
      amountCents,
      status: { in: ['PENDING', 'SUCCEEDED'] },
      createdAt: { gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
    },
  });
  if (similar > 0) throw new ConflictException(message);
}

/**
 * Pasa una devolución PENDIENTE a su estado final, solo si sigue pendiente
 * (si otra persona ya la resolvió, 409 y la transacción se deshace entera).
 */
export async function settlePendingRefund(
  tx: TransactionalClient,
  refundId: string,
  data: { status: 'SUCCEEDED' | 'FAILED'; providerRefundId?: string | null },
): Promise<void> {
  const done = await tx.refund.updateMany({
    where: { id: refundId, status: 'PENDING' },
    data: {
      status: data.status,
      ...(data.providerRefundId ? { providerRefundId: data.providerRefundId } : {}),
    },
  });
  if (done.count !== 1) {
    throw new ConflictException('Esta devolución ya no está pendiente (la resolvió otra persona). Recarga la lista.');
  }
}
