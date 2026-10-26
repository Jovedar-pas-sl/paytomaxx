import { ConflictException } from '@nestjs/common';
import { refundServiceFeePart } from '@nightpay/contracts';
import type { Prisma } from '@nightpay/db';
import type { TransactionalClient } from '../../common/prisma/prisma.service';
import { pendingRefundApprovalCents } from '../approvals/approval-store';
import { chargedCentsOf, refundableFeeCents } from '../payments/service-fee';

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
 * devolución, así que nunca cuenta dos veces ni deja un hueco. Con
 * `approvals: false` no cuenta lo pedido (apuntar una devolución que ya salió
 * del banco: si luego no cabe lo pedido, la solicitud falla al aprobarla).
 */
export async function reservedRefundCents(
  tx: TransactionalClient,
  paymentId: string,
  now: Date = new Date(),
  opts: { approvals?: boolean } = {},
): Promise<number> {
  const agg = await tx.refund.aggregate({
    where: {
      paymentId,
      status: 'PENDING',
      OR: [{ registeredManually: false }, { createdAt: { gte: new Date(now.getTime() - LEGACY_BANK_PENDING_MS) } }],
    },
    _sum: { amountCents: true },
  });
  const pendingApprovals = opts.approvals === false ? 0 : await pendingRefundApprovalCents(tx, paymentId, now);
  return (agg._sum.amountCents ?? 0) + pendingApprovals;
}

/**
 * Lo devuelto por la pasarela en este cobro (pendiente o hecho) por TODAS las
 * personas: el umbral de «Por aprobar» va por cobro, no por quién lo pide
 * (dos encargados con 60 € cada uno en el mismo cobro no se saltan al dueño).
 * Las del banco no cuentan: las apunta el dueño, que no pide permiso.
 */
export async function apiRefundedOnPaymentCents(
  tx: TransactionalClient,
  tenantId: string,
  paymentId: string,
): Promise<number> {
  const agg = await tx.refund.aggregate({
    where: { tenantId, paymentId, registeredManually: false, status: { in: ['PENDING', 'SUCCEEDED'] } },
    _sum: { amountCents: true },
  });
  return agg._sum.amountCents ?? 0;
}

/** Lo que aún se puede devolver: lo devolvible menos lo reservado. Si no cabe, 409. */
export async function assertRefundFits(
  tx: TransactionalClient,
  paymentId: string,
  locked: LockedRefundablePayment,
  amountCents: number,
  opts: { approvals?: boolean } = {},
): Promise<void> {
  const free = locked.availableAmountCents - (await reservedRefundCents(tx, paymentId, new Date(), opts));
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
  data: { status: 'SUCCEEDED' | 'FAILED'; providerRefundId?: string | null; replayResponse?: Prisma.InputJsonValue },
): Promise<void> {
  const done = await tx.refund.updateMany({
    where: { id: refundId, status: 'PENDING' },
    data: {
      status: data.status,
      ...(data.providerRefundId ? { providerRefundId: data.providerRefundId } : {}),
      ...(data.replayResponse ? { replayResponse: data.replayResponse } : {}),
    },
  });
  if (done.count !== 1) {
    throw new ConflictException('Esta devolución ya no está pendiente (la resolvió otra persona). Recarga la lista.');
  }
}

/** Lo del cobro que hace falta para repartir una devolución (la fila bloqueada de transition()). */
export interface RefundedPaymentLike {
  id: string;
  amountCents: number;
  serviceFeeCents?: number | null;
  tipCents: number;
  walletId: string | null;
}

/**
 * La parte de una devolución ya hecha (SUCCEEDED) que es «Comisión del
 * servicio»: en proporción a lo cobrado (importe + comisión + propina), por lo
 * acumulado: con las devoluciones hechas antes, lo devuelto de la comisión es
 * round(comisión × devuelto / cobrado) y esta lleva lo que falta. Se apunta en
 * la devolución (refunds.serviceFeeCents) dentro de la transacción del cobro
 * bloqueado, así dos devoluciones no se pisan. Deja de ser ingreso de OxioPay.
 * En una recarga, nunca (se devuelve solo el saldo); sin comisión, ni se consulta.
 */
export async function stampRefundServiceFee(
  tx: Pick<TransactionalClient, 'refund'>,
  payment: RefundedPaymentLike,
  refundId: string,
  refundCents: number,
): Promise<number> {
  const feeCents = refundableFeeCents(payment);
  if (feeCents <= 0) return 0;
  const prior = await tx.refund.aggregate({
    where: { paymentId: payment.id, status: 'SUCCEEDED', id: { not: refundId } },
    _sum: { amountCents: true, serviceFeeCents: true },
  });
  const part = refundServiceFeePart({
    feeCents,
    chargedCents: chargedCentsOf(payment),
    refundedAfterCents: (prior._sum.amountCents ?? 0) + refundCents,
    feeRefundedBeforeCents: prior._sum.serviceFeeCents ?? 0,
  });
  if (part > 0) await tx.refund.update({ where: { id: refundId }, data: { serviceFeeCents: part } });
  return part;
}
