import { ConflictException } from '@nestjs/common';
import { APPROVAL_TTL_MS, type ApprovalKind } from '@nightpay/contracts';
import type { TransactionalClient } from '../../common/prisma/prisma.service';
import { eurShort } from './approval-rules';

/**
 * Piezas de approval_requests que van DENTRO de una transacción (la tabla
 * tiene FORCE RLS: el local, o el bypass, va en la sesión de la transacción).
 * Una solicitud pendiente cuenta solo durante 24 h: pasado eso ya no reserva
 * aunque nadie la haya marcado aún como caducada.
 */

/** Pedidas antes de esto ya han caducado. */
export function expiryCutoff(now: Date): Date {
  return new Date(now.getTime() - APPROVAL_TTL_MS);
}

/** Otra persona la decidió a la vez (o caducó): quien llega tarde no hace nada. */
export class ApprovalAlreadyDecidedError extends Error {
  constructor() {
    super('La solicitud ya no está pendiente');
    this.name = 'ApprovalAlreadyDecidedError';
  }
}

/**
 * Lo que tienen pedido para devolver las solicitudes pendientes de un cobro:
 * igual que una devolución en curso, ese importe no se puede devolver por
 * otro lado hasta que se decida (o caduque).
 */
export async function pendingRefundApprovalCents(
  tx: TransactionalClient,
  paymentId: string,
  now: Date = new Date(),
): Promise<number> {
  const agg = await tx.approvalRequest.aggregate({
    where: { kind: 'REFUND', targetId: paymentId, status: 'PENDING', requestedAt: { gt: expiryCutoff(now) } },
    _sum: { amountCents: true },
  });
  return agg._sum.amountCents ?? 0;
}

/** La petición de pago pendiente de una chica (como mucho hay una). */
export async function pendingPayoutRequest(
  tx: TransactionalClient,
  tenantId: string,
  operatorId: string,
  now: Date = new Date(),
): Promise<{ id: string; amountCents: number } | null> {
  return tx.approvalRequest.findFirst({
    where: { tenantId, kind: 'PAYOUT', targetId: operatorId, status: 'PENDING', requestedAt: { gt: expiryCutoff(now) } },
    select: { id: true, amountCents: true },
  });
}

export function payoutAlreadyRequested(amountCents?: number): ConflictException {
  const amount = amountCents ? ` de ${eurShort(amountCents)}` : '';
  return new ConflictException({
    message: `Ya hay un pago${amount} pedido al dueño para esta chica: apruébalo o recházalo en «Por aprobar» antes de pagar otro.`,
    code: 'APPROVAL_ALREADY_PENDING',
  });
}

/**
 * Pago directo (dueño, o encargado sin aprobación): si hay una petición
 * pendiente para la chica, sus comisiones están reservadas → 409.
 */
export async function assertNoPendingPayout(
  tx: TransactionalClient,
  tenantId: string,
  operatorId: string,
  now: Date = new Date(),
): Promise<void> {
  const pending = await pendingPayoutRequest(tx, tenantId, operatorId, now);
  if (pending) throw payoutAlreadyRequested(pending.amountCents);
}

/**
 * Marca la aprobación (PENDING → APPROVED) dentro de la transacción que hace
 * lo pedido. Si otra persona ya la decidió, o caducó, no hace nada más
 * (ApprovalAlreadyDecidedError): así aprobar dos veces nunca paga dos veces.
 */
export async function claimApproval(
  tx: TransactionalClient,
  approvalId: string,
  deciderId: string,
  now: Date,
): Promise<void> {
  const { count } = await tx.approvalRequest.updateMany({
    where: { id: approvalId, status: 'PENDING', requestedAt: { gt: expiryCutoff(now) } },
    data: { status: 'APPROVED', decidedById: deciderId, decidedAt: now },
  });
  if (count !== 1) throw new ApprovalAlreadyDecidedError();
}

/** Lo que salió al aprobarla (pago a la chica o devolución). */
export async function setApprovalResult(tx: TransactionalClient, approvalId: string, resultRef: string): Promise<void> {
  await tx.approvalRequest.updateMany({ where: { id: approvalId, status: 'APPROVED' }, data: { resultRef } });
}

export interface ExpiredRow {
  id: string;
  tenantId: string;
  kind: ApprovalKind;
  amountCents: number;
  requestedById: string;
}

/**
 * Pendientes de más de 24 h → EXPIRED (opcionalmente solo las de una chica o
 * un cobro). Devuelve las que ha caducado (para el registro).
 */
export async function expirePending(
  tx: TransactionalClient,
  now: Date,
  filter: { targetId?: string } = {},
): Promise<ExpiredRow[]> {
  const where = {
    status: 'PENDING' as const,
    requestedAt: { lte: expiryCutoff(now) },
    ...(filter.targetId ? { targetId: filter.targetId } : {}),
  };
  const rows = await tx.approvalRequest.findMany({
    where,
    select: { id: true, tenantId: true, kind: true, amountCents: true, requestedById: true },
    take: 500,
  });
  if (rows.length === 0) return [];
  await tx.approvalRequest.updateMany({
    where: { ...where, id: { in: rows.map((r) => r.id) } },
    data: { status: 'EXPIRED', decidedAt: now },
  });
  return rows;
}
