import { stepUpActions } from '@nightpay/contracts';
import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ApprovalView } from '@nightpay/contracts';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TotpService } from '../auth/totp.service';
import { OperatorsService } from '../operators/operators.service';
import { PAYOUT_CHANGED_CODE, payoutChanged } from '../operators/payout-selection';
import { RefundsService } from '../refunds/refunds.service';
import {
  PayoutPayloadSchema,
  RefundPayloadSchema,
  accountFingerprint,
  isCashRefundPayload,
  type ApprovalRow,
  type PayoutPayload,
} from './approval-payload';
import { ApprovalRequestsService, type ApprovalActor } from './approval-requests.service';
import { failureReasonOf, isLastingFailure, notPendingMessage } from './approval-rules';
import { ApprovalAlreadyDecidedError, claimApproval, setApprovalResult } from './approval-store';

/** El `code` del cuerpo de un error HTTP de Nest (null si no lleva). */
function codeOf(err: unknown): string | null {
  const body = (err as { getResponse?: () => unknown }).getResponse?.();
  const code = typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : null;
  return typeof code === 'string' ? code : null;
}

/**
 * Lo aprobado no se pudo hacer: la solicitud queda fallida con la razón. Si
 * lo pedido ya no es lo que hay (otra cifra, otra cuenta, ya pagado), con
 * PAYOUT_CHANGED: no se ha pagado nada y el panel lo dice así.
 */
function approvalFailed(reason: string, cause: unknown): ConflictException {
  if (codeOf(cause) === PAYOUT_CHANGED_CODE) {
    return new ConflictException({ message: `No se ha pagado nada: ${reason}`, code: PAYOUT_CHANGED_CODE });
  }
  return new ConflictException({ message: `No se ha podido hacer: ${reason}`, code: 'APPROVAL_FAILED' });
}

/**
 * Aprobar = hacer lo pedido con los servicios de siempre (createPayout,
 * RefundsService.refund), en la transacción del local:
 *  - 2FA del dueño obligatoria; quien pidió no aprueba.
 *  - Idempotente: la aprobación se marca (PENDING → APPROVED) DENTRO de la
 *    transacción que paga o reserva la devolución. Dos aprobaciones a la vez:
 *    una hace el trabajo; la otra no toca nada y devuelve cómo quedó.
 *  - Si no se puede hacer por cómo están las cosas (ya pagado, no cabe, la
 *    pasarela la rechaza…) queda FAILED con la razón; si es un fallo pasajero
 *    (base caída…) sigue pendiente para reintentar.
 */
@Injectable()
export class ApprovalsService {
  private readonly logger = new Logger(ApprovalsService.name);
  private readonly prisma: PrismaService;
  private readonly requests: ApprovalRequestsService;
  private readonly operators: OperatorsService;
  private readonly refunds: RefundsService;
  private readonly totp: TotpService;
  private readonly audit: AuditService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(ApprovalRequestsService) requests: ApprovalRequestsService,
    @Inject(OperatorsService) operators: OperatorsService,
    @Inject(RefundsService) refunds: RefundsService,
    @Inject(TotpService) totp: TotpService,
    @Inject(AuditService) audit: AuditService,
  ) {
    this.prisma = prisma;
    this.requests = requests;
    this.operators = operators;
    this.refunds = refunds;
    this.totp = totp;
    this.audit = audit;
  }

  async approve(actor: ApprovalActor, id: string, totpCode: string | undefined): Promise<ApprovalView> {
    const now = new Date();
    const row = await this.requests.decidable(actor, id, now, 'APPROVED');
    // Ya aprobada (doble toque, otra pestaña): cómo quedó, sin volver a hacer nada.
    if (row.status === 'APPROVED') return this.requests.view(actor, row);
    // Con su 2FA o, sin ella, con la prueba de su llave para esta solicitud.
    await this.totp.assertForUser(actor.userId, totpCode, stepUpActions.approve(id));
    try {
      if (row.kind === 'PAYOUT') await this.executePayout(actor, row, now);
      // En efectivo (bitcoin): aprobarla no mueve nada; se apunta al pulsar «Entregado».
      else if (isCashRefundPayload(row.payload)) await this.prisma.withTenant(row.tenantId, (tx) => claimApproval(tx, row.id, actor.userId, now));
      else await this.executeRefund(actor, row, now);
    } catch (err) {
      return this.afterFailure(actor, row, err);
    }
    const done = await this.requests.findRow(actor.tenantId, id);
    if (!done) throw new NotFoundException('Solicitud no encontrada');
    await this.audit.log({
      action: 'approval.approved',
      tenantId: actor.tenantId,
      actorId: actor.userId,
      targetType: 'ApprovalRequest',
      targetId: id,
      payload: { kind: done.kind, amountCents: done.amountCents, resultRef: done.resultRef, requestedById: done.requestedById },
    });
    this.logger.log(`Solicitud ${id} (${done.kind}, ${done.amountCents}c) aprobada por ${actor.userId} → ${done.resultRef}`);
    return this.requests.view(actor, done);
  }

  /** Pago a la chica: exactamente las comisiones y deudas que se pidieron, a su misma cuenta. */
  private async executePayout(actor: ApprovalActor, row: ApprovalRow, now: Date): Promise<void> {
    const parsed = PayoutPayloadSchema.safeParse(row.payload);
    if (!parsed.success) throw new ConflictException('La solicitud está incompleta: que la pidan otra vez.');
    const p = parsed.data;
    await this.operators.createPayout(row.tenantId, p.operatorId, actor.userId, p.notes ?? undefined, {
      externalTxId: p.externalTxId ?? undefined,
      externalRail: p.method ?? undefined,
      receiptUrl: p.receiptUrl ?? undefined,
      exact: { earningIds: p.earningIds, debtIds: p.debtIds, totalCents: row.amountCents },
      // La cifra que vio el encargado: si lo que se va a pagar ya es otro, PAYOUT_CHANGED.
      ...(typeof p.expectedTotalCents === 'number' ? { expectedTotalCents: p.expectedTotalCents } : {}),
      approvalRequestId: row.id,
      inTransaction: async (tx) => {
        await claimApproval(tx, row.id, actor.userId, now);
        await assertSameAccount(tx, row.tenantId, p);
      },
      afterCreate: (tx, payoutId) => setApprovalResult(tx, row.id, payoutId),
    });
  }

  /**
   * Devolución por la pasarela, a nombre de quien la pidió (su acumulado), con
   * la 2FA ya puesta por el dueño al aprobarla.
   */
  private async executeRefund(actor: ApprovalActor, row: ApprovalRow, now: Date): Promise<void> {
    const parsed = RefundPayloadSchema.safeParse(row.payload);
    if (!parsed.success) throw new ConflictException('La solicitud está incompleta: que la pidan otra vez.');
    const r = parsed.data;
    await this.refunds.refund(
      { paymentId: r.paymentId, amountCents: row.amountCents, reason: r.reason ?? undefined, ...(r.idempotencyKey ? { idempotencyKey: r.idempotencyKey } : {}) },
      { userId: row.requestedById, role: 'MANAGER', tenantId: row.tenantId },
      {
        approvalRequestId: row.id,
        approvedBy: actor.userId,
        claim: (tx) => claimApproval(tx, row.id, actor.userId, now),
        onReserved: (tx, refundId) => setApprovalResult(tx, row.id, refundId),
      },
    );
  }

  /**
   * Algo falló al hacerlo: se decide por cómo quedó en la base, no por el
   * error. Otra persona ya la decidió → cómo quedó (o 409). Sigue pendiente
   * y el error es de las cosas → FAILED. Aprobada pero la pasarela rechazó la
   * devolución → FAILED. Lo demás (sin confirmar en la pasarela, base caída…)
   * se devuelve tal cual: la devolución sigue reservada o se reintenta.
   */
  private async afterFailure(actor: ApprovalActor, row: ApprovalRow, err: unknown): Promise<ApprovalView> {
    const current = await this.requests.findRow(actor.tenantId, row.id);
    if (!current) throw err;
    if (err instanceof ApprovalAlreadyDecidedError) {
      if (current.status === 'APPROVED') return this.requests.view(actor, current);
      throw new ConflictException({ message: notPendingMessage(current.status), code: 'APPROVAL_NOT_PENDING' });
    }
    if (current.status === 'PENDING' && isLastingFailure(err)) {
      return this.failWith(actor, current, err, 'PENDING');
    }
    if (current.status === 'APPROVED' && current.kind === 'REFUND' && (await this.refundFailed(current))) {
      return this.failWith(actor, current, err, 'APPROVED');
    }
    throw err;
  }

  /** FAILED con la razón; si otra persona la decidió a la vez, cómo quedó de verdad. */
  private async failWith(actor: ApprovalActor, row: ApprovalRow, err: unknown, from: 'PENDING' | 'APPROVED'): Promise<ApprovalView> {
    const reason = failureReasonOf(err);
    if (await this.requests.markFailed(row, actor, reason, from)) throw approvalFailed(reason, err);
    const now = await this.requests.findRow(actor.tenantId, row.id);
    if (now?.status === 'APPROVED') return this.requests.view(actor, now);
    throw new ConflictException({ message: notPendingMessage(now?.status ?? 'FAILED'), code: 'APPROVAL_NOT_PENDING' });
  }

  /** La devolución que salió al aprobarla acabó FAILED (la pasarela la rechazó). */
  private async refundFailed(row: ApprovalRow): Promise<boolean> {
    if (!row.resultRef) return false;
    const refundId = row.resultRef;
    const refund = await this.prisma.withTenant(row.tenantId, (tx) =>
      tx.refund.findFirst({ where: { id: refundId, tenantId: row.tenantId }, select: { status: true } }),
    );
    return refund?.status === 'FAILED';
  }
}

/** Su cuenta de cobro guardada es la de cuando se pidió (nadie la ha cambiado entretanto). */
async function assertSameAccount(tx: TransactionalClient, tenantId: string, p: PayoutPayload): Promise<void> {
  const saved = await tx.user.findFirst({
    where: { id: p.operatorId, tenantId },
    select: { payoutMethod: true, payoutAddress: true },
  });
  if (!saved || accountFingerprint(saved) !== p.accountFingerprint) {
    throw payoutChanged('La cuenta de cobro de la chica ha cambiado desde que se pidió: revísala y que lo pidan otra vez.');
  }
}
