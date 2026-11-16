import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  APPROVAL_REQUESTED_MESSAGE,
  APPROVAL_TTL_MS,
  BITCOIN_CASH_MAX_CENTS,
  BITCOIN_CASH_REFUND_DAYS,
  bitcoinCashDoneMessage,
  bitcoinCashReasonText,
  stepUpActions,
  type ApprovalRequestedResponse,
  type BitcoinCashConfig,
  type BitcoinCashDone,
  type BitcoinCashRefundDto,
} from '@nightpay/contracts';
import { Prisma } from '@nightpay/db';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { ApprovalRequestsService, type ApprovalActor } from '../approvals/approval-requests.service';
import { CashApprovalPayloadSchema, type CashApprovalPayload } from '../approvals/approval-payload';
import { expiryCutoff } from '../approvals/approval-store';
import { AuditService } from '../audit/audit.service';
import { TotpService } from '../auth/totp.service';
import { btcpayEnabled } from '../btcpay/btcpay-flag';
import { InvalidTransitionError } from '../payments/payment.machine';
import { PaymentsService } from '../payments/payments.service';
import { assertRefundFits, lockPaymentForRefund, REFUNDABLE_STATUSES, stampRefundServiceFee } from '../refunds/refund-ledger';
import { cashAmountProblem, eur, needsOwnerApproval, paymentCashProblem, receiptMatches, strayCashMax } from './bitcoin-cash-rules';

type Actor = ApprovalActor;

/** Lo que se apunta de una devolución en efectivo (directa o al pulsar «Entregado»). */
interface CashInput {
  amountCents: number;
  reason: string;
  receiptCode: string;
  idempotencyKey?: string;
  /** La aprobación del dueño que se está entregando. */
  approvalId?: string;
}

/**
 * Devolver en efectivo lo pagado con bitcoin (Fases B y C). El bitcoin se
 * queda en la cartera del local y el cliente recibe euros de la caja: la
 * devolución sale en el arqueo y en el Z, no en el banco ni en la cartera.
 *  - B: un cobro pagado con bitcoin (registro de devoluciones, con el cobro
 *    bloqueado: baja lo devolvible, se descuenta a la compañera y la parte de
 *    la comisión del servicio).
 *  - C: el bitcoin que llegó SIN cobro (tarde, dos veces o a medias): una fila
 *    en btc_cash_returns, una por factura (índice único).
 * Detrás del interruptor del local (btcpay_stores.cashRefundEnabled). Solo el
 * encargado y el dueño, con su 2FA. Si pasa del umbral del local, el dueño lo
 * aprueba en «Por aprobar» y el encargado pulsa «Entregado» al darlo.
 */
@Injectable()
export class BitcoinCashService {
  private readonly logger = new Logger(BitcoinCashService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(TotpService) private readonly totp: TotpService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ApprovalRequestsService) private readonly approvals: ApprovalRequestsService,
  ) {}

  async config(actor: Actor): Promise<BitcoinCashConfig> {
    const [enabled, threshold] = await Promise.all([this.enabled(actor.tenantId), this.threshold(actor.tenantId)]);
    return {
      enabled: enabled && isManager(actor),
      approvalAboveCents: actor.role === 'OWNER' ? null : threshold,
      days: BITCOIN_CASH_REFUND_DAYS,
      maxCents: BITCOIN_CASH_MAX_CENTS,
    };
  }

  // ─── B: un cobro pagado con bitcoin ──────────────────────────────────

  async refundPayment(actor: Actor, paymentId: string, dto: BitcoinCashRefundDto): Promise<BitcoinCashDone | ApprovalRequestedResponse> {
    await this.assertAllowed(actor);
    const now = new Date();
    if (dto.idempotencyKey) {
      const replay = await this.replayRefund(actor, paymentId, dto.idempotencyKey);
      if (replay) return replay;
    }
    const payment = await this.prisma.payment.findFirst({
      where: { id: paymentId, tenantId: actor.tenantId },
      select: {
        id: true,
        tenantId: true,
        provider: true,
        providerTxId: true,
        status: true,
        walletId: true,
        authorizedAt: true,
        availableAmountCents: true,
        amountCents: true,
        serviceFeeCents: true,
        tipCents: true,
        createdAt: true,
      },
    });
    if (!payment) throw new NotFoundException('Cobro no encontrado');
    const invoice = payment.providerTxId
      ? await this.prisma.asSystem((tx) =>
          tx.btcpayInvoice.findFirst({ where: { paymentId, invoiceId: payment.providerTxId! }, select: { invoiceId: true, status: true, additionalStatus: true } }),
        )
      : null;
    const problem = paymentCashProblem(payment, invoice, now) ?? cashAmountProblem(dto.amountCents, payment.availableAmountCents);
    if (problem) throw new ConflictException({ message: problem, code: 'BITCOIN_CASH_NOT_ALLOWED' });
    if (!receiptMatches(dto.receiptCode, { paymentId, invoiceIds: [invoice?.invoiceId] })) throw receiptMismatch();
    const reason = bitcoinCashReasonText(dto.reason, dto.note);
    const already = await this.refundedCents(actor.tenantId, paymentId);
    const threshold = await this.threshold(actor.tenantId);
    if (needsOwnerApproval({ role: actor.role, alreadyCents: already, amountCents: dto.amountCents, thresholdCents: threshold })) {
      return this.requestApproval(actor, {
        targetId: paymentId,
        amountCents: dto.amountCents,
        payload: {
          paymentId,
          reason,
          paymentAmountCents: payment.amountCents + (payment.serviceFeeCents ?? 0) + payment.tipCents,
          paymentCreatedAt: payment.createdAt.toISOString(),
          cardLast4: null,
          cardBrand: null,
          provider: 'BTCPAY',
          method: 'CASH',
          source: 'payment',
          invoiceId: invoice?.invoiceId ?? null,
          receiptCode: dto.receiptCode,
        },
        idempotencyKey: dto.idempotencyKey,
        reservePayment: true,
      });
    }
    await this.totp.assertForUser(actor.userId, dto.totpCode, stepUpActions.bitcoinCash(paymentId, dto.amountCents));
    const id = await this.payPaymentCash(actor, paymentId, { amountCents: dto.amountCents, reason, receiptCode: dto.receiptCode, idempotencyKey: dto.idempotencyKey });
    return { kind: 'done', id, amountCents: dto.amountCents, message: bitcoinCashDoneMessage(dto.amountCents) };
  }

  // ─── C: el bitcoin que llegó sin cobro ───────────────────────────────

  async returnInvoice(actor: Actor, invoiceId: string, dto: BitcoinCashRefundDto): Promise<BitcoinCashDone | ApprovalRequestedResponse> {
    await this.assertAllowed(actor);
    const now = new Date();
    const invoice = await this.prisma.asSystem((tx) => tx.btcpayInvoice.findUnique({ where: { invoiceId } }));
    if (!invoice || invoice.tenantId !== actor.tenantId) throw new NotFoundException('Factura no encontrada');
    const payment = await this.prisma.payment.findFirst({
      where: { id: invoice.paymentId, tenantId: actor.tenantId },
      select: { id: true, status: true, providerTxId: true, createdAt: true },
    });
    if (!payment) throw new NotFoundException('Cobro no encontrado');
    const max = strayCashMax(invoice, payment, now);
    if (!max.ok) throw new ConflictException({ message: max.problem, code: 'BITCOIN_CASH_NOT_ALLOWED' });
    const amountProblem = cashAmountProblem(dto.amountCents, max.maxCents);
    if (amountProblem) throw new ConflictException({ message: amountProblem, code: 'BITCOIN_CASH_NOT_ALLOWED' });
    if (!receiptMatches(dto.receiptCode, { paymentId: payment.id, invoiceIds: [invoiceId] })) throw receiptMismatch();
    await this.assertNotReturned(actor.tenantId, invoice.id, invoiceId, now);
    const reason = bitcoinCashReasonText(dto.reason, dto.note);
    const threshold = await this.threshold(actor.tenantId);
    if (needsOwnerApproval({ role: actor.role, alreadyCents: 0, amountCents: dto.amountCents, thresholdCents: threshold })) {
      return this.requestApproval(actor, {
        // La factura (no el cobro): no reserva nada de lo devolvible del cobro.
        targetId: invoice.id,
        amountCents: dto.amountCents,
        payload: {
          paymentId: payment.id,
          reason,
          paymentAmountCents: max.maxCents,
          paymentCreatedAt: payment.createdAt.toISOString(),
          cardLast4: null,
          cardBrand: null,
          provider: 'BTCPAY',
          method: 'CASH',
          source: 'invoice',
          invoiceId,
          receiptCode: dto.receiptCode,
        },
        idempotencyKey: dto.idempotencyKey,
        reservePayment: false,
      });
    }
    await this.totp.assertForUser(actor.userId, dto.totpCode, stepUpActions.bitcoinCash(invoice.id, dto.amountCents));
    const id = await this.payStrayCash(actor, { invoiceId, paymentId: payment.id, requestedById: actor.userId }, { amountCents: dto.amountCents, reason, receiptCode: dto.receiptCode });
    return { kind: 'done', id, amountCents: dto.amountCents, message: bitcoinCashDoneMessage(dto.amountCents) };
  }

  // ─── «Entregado»: lo aprobado por el dueño sale de la caja ────────────

  async handOver(actor: Actor, approvalId: string): Promise<BitcoinCashDone> {
    if (!isManager(actor)) throw new ForbiddenException('Solo el encargado o el dueño');
    const row = await this.prisma.withTenant(actor.tenantId, (tx) => tx.approvalRequest.findFirst({ where: { id: approvalId, tenantId: actor.tenantId } }));
    if (!row) throw new NotFoundException('Solicitud no encontrada');
    const parsed = CashApprovalPayloadSchema.safeParse(row.payload);
    if (row.kind !== 'REFUND' || !parsed.success) throw new ConflictException('Esta solicitud no es una devolución en efectivo.');
    if (row.resultRef) {
      return { kind: 'done', id: row.resultRef, amountCents: row.amountCents, message: 'Ya estaba apuntada como entregada.' };
    }
    if (row.status !== 'APPROVED') throw new ConflictException('El dueño aún no la ha aprobado.');
    if (!row.decidedAt || row.decidedAt.getTime() <= Date.now() - APPROVAL_TTL_MS) {
      throw new ConflictException('La aprobación caducó (24 h sin entregarla): si aún hay que devolverlo, pídelo otra vez.');
    }
    const p: CashApprovalPayload = parsed.data;
    const input = { amountCents: row.amountCents, reason: p.reason ?? 'Devolución en efectivo', receiptCode: p.receiptCode, approvalId: row.id };
    const id =
      p.source === 'invoice'
        ? await this.payStrayCash(actor, { invoiceId: p.invoiceId ?? '', paymentId: p.paymentId, requestedById: row.requestedById }, input)
        : await this.payPaymentCash({ ...actor, userId: row.requestedById }, p.paymentId, input, actor.userId);
    return { kind: 'done', id, amountCents: row.amountCents, message: bitcoinCashDoneMessage(row.amountCents) };
  }

  // ─── Apuntar ─────────────────────────────────────────────────────────

  /** B: la devolución (ya hecha, en efectivo) en el registro de devoluciones, con el cobro bloqueado. */
  private async payPaymentCash(actor: Actor, paymentId: string, input: CashInput, paidById: string = actor.userId): Promise<string> {
    const refundId = randomUUID();
    try {
      await this.payments.transition(paymentId, { type: 'REFUND_PARTIAL', amountCents: input.amountCents }, actor.tenantId, {
        prepare: async (tx, locked) => {
          // Lo aprobado ya reservaba su importe: al entregarlo no cuenta lo pedido (como una del banco).
          await assertRefundFits(tx, paymentId, locked, input.amountCents, { approvals: !input.approvalId });
          await tx.refund.create({
            data: {
              id: refundId,
              tenantId: actor.tenantId,
              paymentId,
              amountCents: input.amountCents,
              reason: input.reason,
              requestedBy: actor.userId,
              status: 'SUCCEEDED',
              paidInCash: true,
              receiptCode: input.receiptCode,
              ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
            },
          });
          await stampRefundServiceFee(tx, locked, refundId, input.amountCents);
          if (input.approvalId) await claimHandOver(tx, input.approvalId, refundId);
        },
      });
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        throw new ConflictException('El cobro ya no admite esta devolución (puede que otra se haya apuntado a la vez). Recarga la lista.');
      }
      if (isUniqueViolation(err) && input.idempotencyKey) {
        const replay = await this.replayRefund(actor, paymentId, input.idempotencyKey);
        if (replay) return replay.id;
      }
      throw err;
    }
    await this.reverseEarning(actor, paymentId, refundId, input.amountCents);
    await this.audit.log({
      action: 'refund.cash_registered',
      tenantId: actor.tenantId,
      actorId: paidById,
      targetType: 'Payment',
      targetId: paymentId,
      payload: {
        refundId,
        amountCents: input.amountCents,
        reason: input.reason,
        receiptCode: input.receiptCode,
        requestedBy: actor.userId,
        paidBy: paidById,
        approvalRequestId: input.approvalId ?? null,
      },
    });
    this.logger.warn(`Devolución en efectivo ${refundId}: ${input.amountCents}c del cobro con bitcoin ${paymentId} (entrega ${paidById})`);
    return refundId;
  }

  /** C: el bitcoin que llegó sin cobro, devuelto en efectivo. Una sola vez por factura. */
  private async payStrayCash(
    actor: Actor,
    target: { invoiceId: string; paymentId: string; requestedById: string },
    input: CashInput,
  ): Promise<string> {
    const id = randomUUID();
    try {
      await this.prisma.withTenant(actor.tenantId, async (tx) => {
        if (input.approvalId) await claimHandOver(tx, input.approvalId, id);
        await tx.btcCashReturn.create({
          data: {
            id,
            tenantId: actor.tenantId,
            paymentId: target.paymentId,
            invoiceId: target.invoiceId,
            amountCents: input.amountCents,
            reason: input.reason,
            receiptCode: input.receiptCode,
            requestedById: target.requestedById,
            paidById: actor.userId,
            approvalRequestId: input.approvalId ?? null,
          },
        });
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException('El bitcoin de esta factura ya se devolvió en efectivo.');
      throw err;
    }
    await this.audit.log({
      action: 'bitcoin.cash_returned',
      tenantId: actor.tenantId,
      actorId: actor.userId,
      targetType: 'Payment',
      targetId: target.paymentId,
      payload: { returnId: id, invoiceId: target.invoiceId, amountCents: input.amountCents, reason: input.reason, receiptCode: input.receiptCode, approvalRequestId: input.approvalId ?? null },
    });
    this.logger.warn(`Bitcoin sin cobro devuelto en efectivo ${id}: ${input.amountCents}c de la factura ${target.invoiceId}`);
    return id;
  }

  // ─── Pedirlo al dueño ────────────────────────────────────────────────

  private async requestApproval(
    actor: Actor,
    input: { targetId: string; amountCents: number; payload: CashApprovalPayload; idempotencyKey?: string; reservePayment: boolean },
  ): Promise<ApprovalRequestedResponse> {
    const key = input.idempotencyKey ? `btc-cash:${input.idempotencyKey}` : null;
    const row = await this.prisma.withTenant(actor.tenantId, async (tx) => {
      if (key) {
        const prior = await tx.approvalRequest.findFirst({ where: { tenantId: actor.tenantId, idempotencyKey: key } });
        if (prior) {
          if (prior.targetId !== input.targetId || prior.requestedById !== actor.userId) throw new ConflictException('Esa clave es de otra petición.');
          return { row: prior, replayed: true };
        }
      }
      if (input.reservePayment) {
        // Como una devolución pedida al dueño: cabe y reserva lo pedido hasta que se decida.
        const locked = await lockPaymentForRefund(tx, input.targetId);
        if (!locked || !REFUNDABLE_STATUSES.has(locked.status)) throw new ConflictException('Este cobro ya no se puede devolver.');
        await assertRefundFits(tx, input.targetId, locked, input.amountCents);
      } else {
        await assertNoCashRequest(tx, actor.tenantId, input.targetId, new Date());
      }
      const created = await tx.approvalRequest.create({
        data: {
          tenantId: actor.tenantId,
          kind: 'REFUND',
          targetId: input.targetId,
          amountCents: input.amountCents,
          payload: input.payload,
          requestedById: actor.userId,
          ...(key ? { idempotencyKey: key, idempotencyHash: `${input.targetId}:${input.amountCents}` } : {}),
        },
      });
      return { row: created, replayed: false };
    });
    if (!row.replayed) {
      await this.approvals.announce(actor, row.row, { paymentId: input.payload.paymentId, paymentAmountCents: input.payload.paymentAmountCents });
    }
    return { approvalRequestId: row.row.id, status: 'PENDING', kind: 'REFUND', amountCents: row.row.amountCents, message: APPROVAL_REQUESTED_MESSAGE };
  }

  // ─── Detalles ────────────────────────────────────────────────────────

  private async assertAllowed(actor: Actor): Promise<void> {
    if (!isManager(actor)) throw new ForbiddenException('Devolver en efectivo: solo el encargado o el dueño.');
    if (!(await this.enabled(actor.tenantId))) {
      throw new ConflictException({ message: 'Devolver en efectivo lo pagado con bitcoin está apagado en este local (Ajustes → Bitcoin).', code: 'BITCOIN_CASH_OFF' });
    }
  }

  private async enabled(tenantId: string): Promise<boolean> {
    if (!btcpayEnabled()) return false;
    const store = await this.prisma.asSystem((tx) => tx.btcpayStore.findUnique({ where: { tenantId }, select: { cashRefundEnabled: true } }));
    return store?.cashRefundEnabled === true;
  }

  private async threshold(tenantId: string): Promise<number> {
    const venue = await this.prisma.venue.findUnique({ where: { id: tenantId }, select: { refundApprovalThresholdCents: true } });
    return venue?.refundApprovalThresholdCents ?? 10_000;
  }

  private async refundedCents(tenantId: string, paymentId: string): Promise<number> {
    const agg = await this.prisma.refund.aggregate({ where: { tenantId, paymentId, status: 'SUCCEEDED' }, _sum: { amountCents: true } });
    return agg._sum.amountCents ?? 0;
  }

  /** La devolución en efectivo ya hecha con esta clave (doble toque, se cortó la red): la misma respuesta. */
  private async replayRefund(actor: Actor, paymentId: string, idempotencyKey: string): Promise<BitcoinCashDone | null> {
    const prior = await this.prisma.refund.findUnique({ where: { tenantId_idempotencyKey: { tenantId: actor.tenantId, idempotencyKey } } });
    if (!prior) return null;
    if (prior.paymentId !== paymentId || !prior.paidInCash) throw new ConflictException('Esa clave es de otra devolución.');
    return { kind: 'done', id: prior.id, amountCents: prior.amountCents, message: bitcoinCashDoneMessage(prior.amountCents) };
  }

  private async assertNotReturned(tenantId: string, invoiceRowId: string, invoiceId: string, now: Date): Promise<void> {
    const done = await this.prisma.withTenant(tenantId, (tx) => tx.btcCashReturn.findUnique({ where: { invoiceId }, select: { id: true } }));
    if (done) throw new ConflictException('El bitcoin de esta factura ya se devolvió en efectivo.');
    await this.prisma.withTenant(tenantId, (tx) => assertNoCashRequest(tx, tenantId, invoiceRowId, now));
  }

  /** Descuento de la comisión de la compañera (como cualquier devolución); si falla, queda en el registro. */
  private async reverseEarning(actor: Actor, paymentId: string, refundId: string, amountCents: number): Promise<void> {
    try {
      await this.payments.applyRefundToEarning(paymentId, refundId, amountCents);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error(`Devolución en efectivo ${refundId}: no se pudo descontar a la compañera (${error})`);
      await this.audit.log({
        action: 'refund.earning_reverse_failed',
        tenantId: actor.tenantId,
        actorId: actor.userId,
        targetType: 'Payment',
        targetId: paymentId,
        payload: { refundId, amountCents, error },
      });
    }
  }
}

function isManager(actor: { role: string }): boolean {
  return actor.role === 'OWNER' || actor.role === 'MANAGER';
}

function receiptMismatch(): BadRequestException {
  return new BadRequestException({
    message: 'El código no es el de este pago: pide al cliente el código de su pantalla «Pagado» (3 letras) o el id de su recibo de BTCPay.',
    code: 'BITCOIN_CASH_RECEIPT',
  });
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * Marca la aprobación como entregada con lo que se apuntó, en la misma
 * transacción: dos «Entregado» a la vez apuntan una sola devolución.
 */
async function claimHandOver(tx: TransactionalClient, approvalId: string, resultRef: string): Promise<void> {
  const { count } = await tx.approvalRequest.updateMany({
    where: { id: approvalId, status: 'APPROVED', resultRef: null },
    data: { resultRef },
  });
  if (count !== 1) throw new ConflictException({ message: 'Esta devolución ya está apuntada como entregada.', code: 'CASH_ALREADY_HANDED' });
}

/** El bitcoin de esa factura ya está pedido al dueño (o aprobado y sin entregar). */
async function assertNoCashRequest(tx: TransactionalClient, tenantId: string, targetId: string, now: Date): Promise<void> {
  const cutoff = expiryCutoff(now);
  const open = await tx.approvalRequest.findFirst({
    where: {
      tenantId,
      kind: 'REFUND',
      targetId,
      OR: [
        { status: 'PENDING', requestedAt: { gt: cutoff } },
        { status: 'APPROVED', resultRef: null, decidedAt: { gt: cutoff } },
      ],
    },
    select: { amountCents: true },
  });
  if (open) throw new ConflictException(`Ya está pedido al dueño (${eur(open.amountCents)}): espera a que lo apruebe y pulsa «Entregado».`);
}
