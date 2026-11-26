import { PASSKEY_REQUIRED_CODE, stepUpActions } from '@nightpay/contracts';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../common/prisma/prisma.service';
import { mayReadCobro, seesWholeVenue } from '../payments/payment-read-access';
import { GatewayRegistry } from '../gateways/gateway.registry';
import type { GatewayAdapter } from '../gateways/gateway.adapter';
import { PaymentsService } from '../payments/payments.service';
import { InvalidTransitionError } from '../payments/payment.machine';
import { TotpService } from '../auth/totp.service';
import { totpForbidden } from '../auth/totp-code';
import { AuditService } from '../audit/audit.service';
import { MetricsService } from '../metrics/metrics.service';
import type { Provider, Role } from '@nightpay/contracts';
import type { RequestContext } from '../../common/context/request-context';
import {
  outcomeOfGatewayError,
  outcomeOfGatewayResult,
  type GatewayRefundOutcome,
  type RejectedWhy,
} from './gateway-refund-outcome';
import {
  REFUNDABLE_STATUSES,
  apiRefundedOnPaymentCents,
  assertNotDuplicateBankRefund,
  assertRefundFits,
  lockPaymentForRefund,
  settlePendingRefund,
  stampRefundServiceFee,
} from './refund-ledger';
import { lockRefundsOf, refundTotalsOf, twoFactorReason } from './refund-two-factor';
import { adjustedReason, bankRefundDate } from './bank-refund-date';
import { refundNeedsApproval, refundRoute } from '../approvals/approval-rules';
import type { TransactionalClient } from '../../common/prisma/prisma.service';
import type { Refund } from '@nightpay/db';
import { findRefundApproval, lockRefundIntent, refundIntent } from './refund-intent';
import { replayOfRefund, savedResponse, type RefundReplay, type RefundResult } from './refund-replay';
import { saldoNoSeDevuelve } from '../wallets/saldo-rule';
import { assertNotBitcoin } from './bitcoin-refund';
import { eur } from '../../common/money/eur';

/**
 * Una devolución pendiente no se resuelve a mano hasta pasado este rato: la
 * pasarela aún puede estar contestando a la petición original.
 */
const MANUAL_RESOLVE_AFTER_MS = 2 * 60 * 1000;

const REFUND_TOTP_NOT_ENROLLED =
  'Para devolver desde 100 € hace falta la app de verificación (2FA) y no la tienes activada: pide al dueño que te la active.';

export interface RefundRequest {
  paymentId: string;
  amountCents: number;
  reason?: string;
  totpCode?: string;
  /**
   * Clave de la intención (la pone la pantalla). Sin ella, cada petición es
   * una devolución distinta (otros caminos y clientes antiguos).
   */
  idempotencyKey?: string;
}

/**
 * Fase 1C — devolución ya hecha por el dueño en el portal de BBVA (Redsys no
 * devuelve por API desde NightPay). Aquí solo se apunta, para que el cobro,
 * la parte de la chica y los informes cuadren con el banco.
 */
export interface BankRefundRequest {
  paymentId: string;
  amountCents: number;
  reason: string;
  /** Referencia que da el portal del banco (opcional). */
  bankReference?: string;
  /** Día en que se hizo la devolución en el banco (por defecto, ahora). */
  refundedAt?: Date;
  /** Ya hay otra devolución igual reciente y el dueño confirma que es otra. */
  confirmDuplicate?: boolean;
}

/** El dueño miró en la pasarela una devolución que quedó sin confirmar. */
export interface ResolvePendingRequest {
  paymentId: string;
  refundId: string;
  outcome: 'SUCCEEDED' | 'FAILED';
  note: string;
}

type Actor = { userId: string; role: Role; tenantId: string };

/**
 * «Por aprobar»: devolución que pidió el encargado y aprobó el dueño (con su
 * 2FA, ya comprobada). Se reserva como cualquier otra, pero dentro de esa
 * misma transacción se marca la aprobación (deja de reservar justo cuando
 * reserva la devolución) y se apunta qué devolución salió.
 */
export interface ApprovedRefund {
  approvalRequestId: string;
  approvedBy: string;
  /** Marca la aprobación; si ya estaba decidida, lanza y no se reserva nada. */
  claim: (tx: TransactionalClient) => Promise<void>;
  /** Con la devolución ya creada (PENDING), en la misma transacción. */
  onReserved: (tx: TransactionalClient, refundId: string) => Promise<void>;
}

interface RefundTarget {
  id: string;
  tenantId: string;
  provider: Provider;
  providerTxId: string;
}

type RejectedOutcome = Extract<GatewayRefundOutcome, { kind: 'rejected' }>;
type UnknownOutcome = Extract<GatewayRefundOutcome, { kind: 'unknown' }>;

const REJECTED_MESSAGES: Record<RejectedWhy, string> = {
  declined: 'La pasarela rechazó la devolución: no se ha devuelto nada.',
  unsupported:
    'Esta pasarela no devuelve por API: haz la devolución en su portal y apúntala con «Devolución hecha en el banco».',
  not_sent: 'No se pudo hablar con la pasarela: no se ha devuelto nada. Prueba otra vez en un rato.',
};

@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);
  private readonly prisma: PrismaService;
  private readonly cls: ClsService<{ ctx: RequestContext }>;
  private readonly gateways: GatewayRegistry;
  private readonly payments: PaymentsService;
  private readonly totp: TotpService;
  private readonly audit: AuditService;
  private readonly metrics: MetricsService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(ClsService) cls: ClsService<{ ctx: RequestContext }>,
    @Inject(GatewayRegistry) gateways: GatewayRegistry,
    @Inject(PaymentsService) payments: PaymentsService,
    @Inject(TotpService) totp: TotpService,
    @Inject(AuditService) audit: AuditService,
    @Inject(MetricsService) metrics: MetricsService,
  ) {
    this.prisma = prisma;
    this.cls = cls;
    this.gateways = gateways;
    this.payments = payments;
    this.totp = totp;
    this.audit = audit;
    this.metrics = metrics;
  }

  /**
   * Devolución por la pasarela. El importe queda reservado (PENDING) con la
   * fila del cobro bloqueada; al confirmarla, el paso a SUCCEEDED y el
   * descuento del cobro van en la MISMA transacción: en ningún momento deja
   * de contar, así que dos devoluciones a la vez no pasan de lo cobrado.
   */
  async refund(request: RefundRequest, actor: Actor, approved?: ApprovedRefund): Promise<RefundResult | RefundReplay> {
    if (actor.role === 'WAITER') {
      throw new ForbiddenException('WAITER cannot refund');
    }
    // Reintento con su clave: lo que pasó la primera vez, antes de volver a
    // mirar el cobro (ya lo pasó) y sin ir otra vez al banco. Lo aprobado por
    // el dueño no: su candado es la propia aprobación (aprobar dos veces da
    // «ya decidida»).
    const earlier = approved ? null : await this.replay(request, actor);
    if (earlier) return earlier;
    let target: { payment: RefundTarget; adapter: GatewayAdapter };
    try {
      target = await this.refundTarget(request);
    } catch (err) {
      // La primera pudo terminar entre medias y el cobro ya no admite otra.
      const finished = approved ? null : await this.replay(request, actor);
      if (finished) return finished;
      throw err;
    }
    const { payment, adapter } = target;
    const reservation = await this.reserveApiRefund(payment, request, actor, approved);
    if ('replay' in reservation) return reservation.replay;
    const { refund, twoFactorRequired } = reservation;
    const outcome = await this.askGateway(adapter, payment, refund.id, request);
    if (outcome.kind === 'rejected') return this.rejectRefund(payment, refund.id, outcome);
    if (outcome.kind === 'unknown') return this.keepRefundPending(payment, refund.id, request.amountCents, outcome, actor);

    await this.settleApiRefund(payment, refund.id, request.amountCents, outcome.providerRefundId, actor);
    await this.audit.log({
      action: 'refund.created',
      tenantId: payment.tenantId,
      actorId: actor.userId,
      targetType: 'Payment',
      targetId: payment.id,
      payload: {
        refundId: refund.id,
        amountCents: request.amountCents,
        provider: payment.provider,
        providerRefundId: outcome.providerRefundId,
        twoFactorRequired,
        ...(approved ? { approvalRequestId: approved.approvalRequestId, approvedBy: approved.approvedBy } : {}),
      },
    });
    const traceId = this.cls.get('ctx')?.traceId ?? randomUUID();
    this.logger.log(
      `Refund ${refund.id} -> ${request.amountCents}c on payment ${payment.id} actor=${actor.userId} trace=${traceId}`,
    );
    return {
      id: refund.id,
      paymentId: payment.id,
      amountCents: request.amountCents,
      status: 'SUCCEEDED' as const,
      providerRefundId: outcome.providerRefundId,
    };
  }

  /**
   * La devolución pedida antes con esta clave, como quedó (null si no hay o
   * no lleva clave). Antes del umbral, el importe, el estado del cobro y la
   * 2FA: la petición original ya los pasó.
   */
  async replay(request: RefundRequest, actor: Actor): Promise<RefundReplay | null> {
    if (!request.idempotencyKey) return null;
    const row = await this.prisma.refund.findUnique({
      where: { tenantId_idempotencyKey: { tenantId: actor.tenantId, idempotencyKey: request.idempotencyKey } },
    });
    return row ? replayOfRefund(row, request, actor) : null;
  }

  /**
   * 2FA según lo devuelto ACUMULADO por esta persona (mismo cobro y últimas
   * 24 h), no por petición: 99,99 € × N ya no lo esquiva. Se decide dentro de
   * la transacción de la reserva, con su candado por persona tomado, así que
   * dos peticiones suyas a la vez no pasan las dos por debajo del umbral.
   * Intentos y códigos usados, por persona en Redis (vale con varias
   * réplicas). Devuelve si se pidió el código.
   */
  private async checkTwoFactor(
    tx: TransactionalClient,
    request: RefundRequest,
    actor: Actor,
  ): Promise<boolean> {
    const totals = await refundTotalsOf(tx, actor, request.paymentId);
    const reason = twoFactorReason(request.amountCents, totals);
    if (!reason) return false;
    // Su propia ficha, sin el filtro de local: un super-admin que está mirando
    // otro local no aparece en ese local (antes daba «no la tienes activada»).
    const user = await this.prisma.acrossVenues((across) =>
      across.user.findUnique({
        where: { id: actor.userId },
        select: { totpSecret: true, email: true },
      }),
    );
    if (!user?.totpSecret) {
      // Sin 2FA: la prueba de su llave de acceso para ESTA devolución (de un solo uso).
      const action = stepUpActions.refund(request.paymentId, request.amountCents);
      if (await this.totp.passkeyProofFor?.(actor.userId, action)) {
        this.logger.log(`Devolución confirmada con la llave de acceso (${reason}): user=${actor.userId}`);
        return true;
      }
      const passkey = await this.totp.missingSecondFactor?.(actor.userId, action, `Hace falta confirmarlo: ${reason} devueltos (desde 100 € se pide). Confirma con tu llave de acceso (Face ID o el PIN de tu móvil).`);
      if (passkey && (passkey.getResponse() as { code?: unknown }).code === PASSKEY_REQUIRED_CODE) throw passkey;
    }
    if (!request.totpCode) {
      throw totpForbidden('required', `Hace falta el código 2FA: ${reason} devueltos (desde 100 € se pide).`);
    }
    if (!user?.totpSecret) throw totpForbidden('notEnrolled', REFUND_TOTP_NOT_ENROLLED);
    try {
      await this.totp.checkStoredForUser(actor.userId, user.totpSecret, request.totpCode);
    } catch (err) {
      this.logger.warn(`2FA rechazada en una devolución: user ${actor.userId} (${user.email})`);
      throw err;
    }
    this.logger.log(`TOTP verified for refund (${reason}): user=${actor.userId}`);
    return true;
  }

  /** Comprobaciones rápidas (sin candado) y la pasarela con la que se devolverá. */
  private async refundTarget(request: RefundRequest): Promise<{ payment: RefundTarget; adapter: GatewayAdapter }> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: request.paymentId },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    // Una recarga del saldo: el saldo no se devuelve (saldo-rule.ts), entrara como entrara.
    if (payment.walletId) throw saldoNoSeDevuelve();
    assertNotBitcoin(payment.provider);
    if (!REFUNDABLE_STATUSES.has(payment.status)) {
      throw new ConflictException(`Cannot refund payment in state ${payment.status}`);
    }
    if (request.amountCents > payment.availableAmountCents) {
      throw new BadRequestException(
        `amountCents (${request.amountCents}) exceeds available (${payment.availableAmountCents})`,
      );
    }
    if (!payment.providerTxId || !payment.provider) {
      throw new ConflictException('Payment has no provider transaction id');
    }
    const target: RefundTarget = {
      id: payment.id,
      tenantId: payment.tenantId,
      provider: payment.provider,
      providerTxId: payment.providerTxId,
    };
    return { payment: target, adapter: this.adapterFor(target.provider) };
  }

  private adapterFor(provider: Provider): GatewayAdapter {
    try {
      return this.gateways.get(provider);
    } catch {
      throw new ConflictException('No hay pasarela configurada para devolver este cobro');
    }
  }

  /**
   * Reserva (PENDING) con el candado de la persona (2FA) y la fila del cobro
   * bloqueada: cuenta lo que queda por devolver menos lo que reservan otras
   * devoluciones aún sin confirmar.
   */
  private async reserveApiRefund(
    payment: RefundTarget,
    request: RefundRequest,
    actor: Actor,
    approved: ApprovedRefund | undefined,
  ): Promise<{ replay: RefundReplay } | { refund: Refund; twoFactorRequired: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      // Una intención, una reserva: dos peticiones con la misma clave a la vez
      // esperan aquí y la segunda ve la de la primera.
      if (request.idempotencyKey) {
        await lockRefundIntent(tx, actor.tenantId, request.idempotencyKey);
        if (!approved) {
          const existing = await tx.refund.findUnique({
            where: { tenantId_idempotencyKey: { tenantId: actor.tenantId, idempotencyKey: request.idempotencyKey } },
          });
          if (existing) return { replay: replayOfRefund(existing, request, actor) };
          // Ya se pidió al dueño con esta clave: lo pendiente es esa solicitud.
          if (await findRefundApproval(tx, request, actor)) throw refundNeedsApproval(request.amountCents, 0);
        }
      }
      await lockRefundsOf(tx, actor.userId);
      const locked = await lockPaymentForRefund(tx, payment.id);
      if (!locked || !REFUNDABLE_STATUSES.has(locked.status)) {
        throw new ConflictException(`Cannot refund payment in state ${locked?.status ?? 'desconocido'}`);
      }
      // Aprobada: deja de reservar como solicitud antes de contar lo reservado.
      if (approved) await approved.claim(tx);
      // Primero si cabe (no se pide un código para algo imposible), luego si le
      // toca pedirla al dueño y el 2FA (en una aprobada ya lo puso el dueño).
      await assertRefundFits(tx, payment.id, locked, request.amountCents);
      if (!approved) await assertBelowApprovalThreshold(tx, payment, request.amountCents, actor);
      const twoFactorRequired = approved ? false : await this.checkTwoFactor(tx, request, actor);
      const refund = await tx.refund.create({
        data: {
          tenantId: payment.tenantId,
          paymentId: payment.id,
          amountCents: request.amountCents,
          reason: request.reason,
          requestedBy: actor.userId,
          status: 'PENDING',
          ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey, intentFingerprint: refundIntent(request, actor) } : {}),
        },
      });
      if (approved) await approved.onReserved(tx, refund.id);
      return { refund, twoFactorRequired };
    });
  }

  /** Pide la devolución a la pasarela (idempotente por refund.id) y clasifica la respuesta. */
  private async askGateway(
    adapter: GatewayAdapter,
    payment: RefundTarget,
    refundId: string,
    request: RefundRequest,
  ): Promise<GatewayRefundOutcome> {
    try {
      const result = await adapter.refund({
        tenantId: payment.tenantId,
        paymentId: payment.id,
        providerTxId: payment.providerTxId,
        amountCents: request.amountCents,
        reason: request.reason,
        reference: refundId,
      });
      return outcomeOfGatewayResult(result);
    } catch (err) {
      return outcomeOfGatewayError(err);
    }
  }

  /** Seguro que no se hizo: la reserva se libera (FAILED). */
  private async rejectRefund(payment: RefundTarget, refundId: string, outcome: RejectedOutcome): Promise<never> {
    const response = { message: REJECTED_MESSAGES[outcome.why], code: 'REFUND_REJECTED', refundId };
    this.logger.error(`Refund ${refundId} no hecha por la pasarela (${outcome.why}): ${outcome.reason}`);
    await this.prisma.refund.update({
      where: { id: refundId },
      data: {
        status: 'FAILED',
        replayResponse: savedResponse(409, response),
        ...(outcome.providerRefundId ? { providerRefundId: outcome.providerRefundId } : {}),
      },
    });
    this.metrics.refundsCreated.inc({ venue: payment.tenantId, provider: payment.provider, status: 'failed' });
    throw new ConflictException(response);
  }

  /**
   * No sabemos si la pasarela la hizo: queda PENDING (sigue reservando) y se
   * avisa para que el dueño lo mire. Marcarla FAILED permitiría repetirla y
   * devolver dos veces.
   */
  private async keepRefundPending(
    payment: RefundTarget,
    refundId: string,
    amountCents: number,
    outcome: UnknownOutcome,
    actor: Actor,
  ): Promise<never> {
    const response = {
      message: 'No sabemos si la pasarela ha hecho la devolución. Queda pendiente (y reservada) para que no se repita: ' +
        'mírala en el portal de la pasarela y márcala como hecha o no hecha en el cobro.',
      code: 'REFUND_OUTCOME_UNKNOWN', refundId,
    };
    await this.prisma.refund.update({ where: { id: refundId }, data: {
      ...(outcome.providerRefundId ? { providerRefundId: outcome.providerRefundId } : {}),
      replayResponse: savedResponse(502, response),
    } });
    this.metrics.refundsCreated.inc({ venue: payment.tenantId, provider: payment.provider, status: 'unknown' });
    this.logger.error(
      `Devolución ${refundId} SIN CONFIRMAR en la pasarela (cobro ${payment.id}, ${amountCents}c): ${outcome.reason}`,
    );
    await this.audit.log({
      action: 'refund.outcome_unknown',
      tenantId: payment.tenantId,
      actorId: actor.userId,
      targetType: 'Payment',
      targetId: payment.id,
      payload: { refundId, amountCents, provider: payment.provider, reason: outcome.reason },
    });
    throw new BadGatewayException(response);
  }

  /**
   * La pasarela la hizo: SUCCEEDED y descuento del cobro en una sola
   * transacción (la del FSM, con la fila bloqueada). Si el cobro no la admite,
   * el dinero ya salió: queda PENDING (reservada) y se avisa — nunca en silencio.
   */
  private async settleApiRefund(
    payment: RefundTarget,
    refundId: string,
    amountCents: number,
    providerRefundId: string,
    actor: Actor,
  ): Promise<void> {
    try {
      await this.payments.transition(payment.id, { type: 'REFUND_PARTIAL', amountCents }, actor.tenantId, {
        // La respuesta va con el paso a SUCCEEDED: si se pierde, el reintento la recupera.
        // Y, con el cobro bloqueado, la parte que era «Comisión del servicio».
        prepare: async (tx, locked) => {
          await settlePendingRefund(tx, refundId, {
            status: 'SUCCEEDED',
            providerRefundId,
            replayResponse: savedResponse(201, { id: refundId, paymentId: payment.id, amountCents, status: 'SUCCEEDED', providerRefundId }),
          });
          await stampRefundServiceFee(tx, locked, refundId, amountCents);
        },
      });
    } catch (err) {
      await this.flagSettleFailed(payment, refundId, amountCents, actor, err);
      if (err instanceof InvalidTransitionError || err instanceof ConflictException) {
        const response = {
          message:
            'La pasarela ha hecho la devolución, pero el cobro no admite apuntarla. ' +
            'Queda pendiente de revisar en Incidencias: no la repitas.',
          code: 'REFUND_SETTLE_REJECTED',
          refundId,
        };
        await this.prisma.refund.updateMany({ where: { id: refundId, status: 'PENDING' }, data: { replayResponse: savedResponse(409, response) } });
        throw new ConflictException(response);
      }
      throw err;
    }
    this.metrics.refundsCreated.inc({ venue: payment.tenantId, provider: payment.provider, status: 'success' });
    await this.reverseEarning(payment, refundId, amountCents, actor);
  }

  private async flagSettleFailed(
    payment: RefundTarget,
    refundId: string,
    amountCents: number,
    actor: Actor,
    err: unknown,
  ): Promise<void> {
    const error = err instanceof Error ? err.message : String(err);
    this.logger.error(
      `CRÍTICO: devolución ${refundId} hecha en la pasarela pero sin apuntar en el cobro ${payment.id} (${amountCents}c): ${error}`,
    );
    await this.audit.log({
      action: 'refund.settle_failed',
      tenantId: payment.tenantId,
      actorId: actor.userId,
      targetType: 'Payment',
      targetId: payment.id,
      payload: { refundId, amountCents, provider: payment.provider, error },
    });
  }

  /**
   * Apunta una devolución que el dueño ya hizo en el portal de BBVA. No toca
   * el banco: ajusta el cobro (importe devolvible y estado) y descuenta la
   * parte de la chica, también si ya se le había pagado (queda como deuda).
   */
  async registerBankRefund(
    request: BankRefundRequest,
    actor: Actor,
    /**
     * Saldo NightPay: la devolución del saldo del cliente se reparte entre sus
     * recargas. Ahí sí se devuelven recargas de wallet (el saldo lo descuenta
     * quien llama) y no se pregunta por repetidas (cada trozo es distinto).
     */
    opts: { walletPayout?: boolean } = {},
  ) {
    if (actor.role !== 'OWNER') {
      throw new ForbiddenException('Solo el dueño puede registrar devoluciones del banco');
    }
    const payment = await this.bankRefundablePayment(request, actor, opts);
    const requestedAt = request.refundedAt ?? new Date();
    if (requestedAt.getTime() > Date.now() + 60_000) {
      throw new BadRequestException('La fecha de la devolución no puede ser futura');
    }
    // Ni antes del cobro ni en un trimestre ya cerrado (303): si no, ajuste con fecha de hoy.
    const dated = bankRefundDate(requestedAt, payment.authorizedAt ?? payment.createdAt, new Date());
    const refundedAt = dated.at;
    const reason = dated.adjusted ? adjustedReason(request.reason, requestedAt, dated.adjusted) : request.reason;
    const refundId = randomUUID();
    await this.applyBankRefund(payment, refundId, { ...request, reason, refundedAt }, actor, opts);

    this.metrics.refundsCreated.inc({
      venue: payment.tenantId,
      provider: payment.provider ?? 'NONE',
      status: 'registered',
    });
    await this.reverseEarning({ id: payment.id, tenantId: payment.tenantId }, refundId, request.amountCents, actor);
    await this.audit.log({
      action: 'refund.bank_registered',
      tenantId: payment.tenantId,
      actorId: actor.userId,
      targetType: 'Payment',
      targetId: payment.id,
      payload: {
        refundId,
        amountCents: request.amountCents,
        bankReference: request.bankReference ?? null,
        refundedAt: refundedAt.toISOString(),
        ...(dated.adjusted ? { requestedRefundedAt: requestedAt.toISOString(), dateAdjusted: dated.adjusted } : {}),
        reason: request.reason,
        confirmedDuplicate: Boolean(request.confirmDuplicate),
      },
    });
    this.logger.log(
      `Devolución BBVA registrada ${refundId}: ${request.amountCents}c en cobro ${payment.id} por ${actor.userId}`,
    );
    return {
      id: refundId,
      paymentId: payment.id,
      amountCents: request.amountCents,
      status: 'SUCCEEDED' as const,
      providerRefundId: request.bankReference ?? null,
      /** El día con el que cuenta en los informes (hoy si se ajustó: dateAdjusted). */
      refundedAt: refundedAt.toISOString(),
      dateAdjusted: dated.adjusted,
    };
  }

  /** Comprobaciones rápidas (sin candado) de una devolución del banco. */
  private async bankRefundablePayment(request: BankRefundRequest, actor: Actor, opts: { walletPayout?: boolean }) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: request.paymentId },
      select: {
        id: true,
        tenantId: true,
        status: true,
        availableAmountCents: true,
        walletId: true,
        provider: true,
        authorizedAt: true,
        createdAt: true,
      },
    });
    if (!payment || payment.tenantId !== actor.tenantId) throw new NotFoundException('Payment not found');
    // Una recarga del saldo: el saldo no se devuelve (saldo-rule.ts). Solo la
    // devolución «A la tarjeta» que se pidió antes y se termina ahora
    // (WalletChargesService.payout) apunta en sus recargas.
    if (payment.walletId && !opts.walletPayout) throw saldoNoSeDevuelve();
    assertNotBitcoin(payment.provider);
    if (!REFUNDABLE_STATUSES.has(payment.status)) {
      throw new ConflictException('Solo se registran devoluciones de cobros pagados');
    }
    if (request.amountCents > payment.availableAmountCents) {
      throw new BadRequestException(
        `La devolución (${eur(request.amountCents)}) supera lo que queda por devolver (${eur(payment.availableAmountCents)})`,
      );
    }
    return payment;
  }

  /**
   * Todo en la transacción del FSM, con la fila del cobro bloqueada: control
   * de repetidas, lo que reservan las devoluciones en curso por la pasarela,
   * alta de la devolución (ya SUCCEEDED) y descuento del cobro. O todo o nada.
   */
  private async applyBankRefund(
    payment: { id: string; tenantId: string },
    refundId: string,
    request: BankRefundRequest & { refundedAt: Date },
    actor: Actor,
    opts: { walletPayout?: boolean },
  ): Promise<void> {
    try {
      await this.payments.transition(
        payment.id,
        { type: 'REFUND_PARTIAL', amountCents: request.amountCents },
        actor.tenantId,
        {
          prepare: async (tx, locked) => {
            if (!request.confirmDuplicate && !opts.walletPayout) {
              await assertNotDuplicateBankRefund(
                tx,
                payment.id,
                request.amountCents,
                `Ya hay una devolución de ${eur(request.amountCents)} registrada en este cobro. Si es otra distinta, confírmalo.`,
              );
            }
            // El dinero ya salió en el portal del banco: se apunta aunque haya una
            // devolución pedida al dueño en este cobro (esa fallará si ya no cabe).
            await assertRefundFits(tx, payment.id, locked, request.amountCents, { approvals: false });
            await tx.refund.create({
              data: {
                id: refundId,
                tenantId: payment.tenantId,
                paymentId: payment.id,
                amountCents: request.amountCents,
                reason: request.reason,
                requestedBy: actor.userId,
                status: 'SUCCEEDED',
                providerRefundId: request.bankReference ?? null,
                registeredManually: true,
                bankRefundedAt: request.refundedAt,
              },
            });
            // La parte que era «Comisión del servicio» (en una recarga, nada).
            await stampRefundServiceFee(tx, locked, refundId, request.amountCents);
          },
        },
      );
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        throw new ConflictException(
          'El cobro ya no admite esta devolución (puede que otra se haya registrado a la vez). Recarga la lista.',
        );
      }
      throw err;
    }
  }

  /**
   * El dueño comprobó en la pasarela una devolución que quedó sin confirmar:
   * hecha (se descuenta del cobro y a la chica) o no hecha (se libera).
   */
  async resolvePending(request: ResolvePendingRequest, actor: Actor) {
    if (actor.role !== 'OWNER') {
      throw new ForbiddenException('Solo el dueño resuelve devoluciones pendientes');
    }
    const refund = await this.pendingRefundToResolve(request, actor);
    if (request.outcome === 'FAILED') {
      await this.prisma.$transaction((tx) => settlePendingRefund(tx, refund.id, { status: 'FAILED' }));
    } else {
      await this.settleResolvedRefund(refund, actor);
    }
    await this.audit.log({
      action: 'refund.pending_resolved',
      tenantId: refund.tenantId,
      actorId: actor.userId,
      targetType: 'Payment',
      targetId: refund.paymentId,
      payload: { refundId: refund.id, amountCents: refund.amountCents, outcome: request.outcome, note: request.note },
    });
    return {
      id: refund.id,
      paymentId: refund.paymentId,
      amountCents: refund.amountCents,
      status: request.outcome,
    };
  }

  private async pendingRefundToResolve(request: ResolvePendingRequest, actor: Actor) {
    const refund = await this.prisma.refund.findFirst({
      where: { id: request.refundId, paymentId: request.paymentId },
    });
    if (!refund || refund.tenantId !== actor.tenantId) throw new NotFoundException('Devolución no encontrada');
    if (refund.status !== 'PENDING') throw new ConflictException('Esta devolución ya no está pendiente');
    if (Date.now() - refund.createdAt.getTime() < MANUAL_RESOLVE_AFTER_MS) {
      throw new ConflictException('Espera un par de minutos: la pasarela aún puede estar contestando.');
    }
    return refund;
  }

  private async settleResolvedRefund(
    refund: { id: string; paymentId: string; tenantId: string; amountCents: number },
    actor: Actor,
  ): Promise<void> {
    try {
      await this.payments.transition(
        refund.paymentId,
        { type: 'REFUND_PARTIAL', amountCents: refund.amountCents },
        actor.tenantId,
        {
          prepare: async (tx, locked) => {
            await settlePendingRefund(tx, refund.id, { status: 'SUCCEEDED' });
            await stampRefundServiceFee(tx, locked, refund.id, refund.amountCents);
          },
        },
      );
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        throw new ConflictException(
          `El cobro no admite apuntar esta devolución (estado ${err.fromState}): revísalo antes de marcarla hecha.`,
        );
      }
      throw err;
    }
    await this.reverseEarning({ id: refund.paymentId, tenantId: refund.tenantId }, refund.id, refund.amountCents, actor);
  }

  /** Descuento de la comisión de la chica por una devolución (con alertas si falla). */
  private async reverseEarning(
    payment: { id: string; tenantId: string },
    refundId: string,
    amountCents: number,
    actor: { userId: string },
  ): Promise<void> {
    // Reverse de la comisión de la operadora (si aplica). Idempotente por refund.id —
    // si el processor reintenta, no duplicamos descuento. Usa accumulator pattern
    // para preservar invariante "total refundeado == amount ⇒ reversed == commission".
    try {
      await this.payments.applyRefundToEarning(payment.id, refundId, amountCents);
    } catch (err) {
      // No bloqueamos el refund (cliente ya recibió dinero), pero esta es una
      // discrepancia financiera crítica: la chica está cobrando comisión de un
      // refund. Tres canales de alerta para que NO pase desapercibido:
      //   1. Métrica Prometheus (alerta a >0)
      //   2. Audit log con action específico ('refund.earning_reverse_failed')
      //      → searchable en admin UI + queryable para reconciliación nocturna
      //   3. Log ERROR con stack completo
      const errorMsg = err instanceof Error ? err.message : String(err);
      // Sin payment_id como etiqueta (cardinalidad): el cobro va en el log y el audit.
      this.metrics.earningReversalFailed.inc({ venue: payment.tenantId });
      this.logger.error(
        `Earning reverse failed for payment ${payment.id} refund ${refundId} (amount=${amountCents}c): ${errorMsg}`,
        err instanceof Error ? err.stack : undefined,
      );
      await this.audit.log({
        action: 'refund.earning_reverse_failed',
        tenantId: payment.tenantId,
        actorId: actor.userId,
        targetType: 'Payment',
        targetId: payment.id,
        payload: {
          refundId,
          amountCents,
          error: errorMsg,
        },
      });
    }
  }

  /**
   * Las devoluciones de un cobro. Con `reader` (el personal): el dueño y el
   * encargado, las de cualquiera; el resto, solo las de sus cobros (de otro,
   * 404 como si no existiera).
   */
  async listForPayment(paymentId: string, reader?: { userId: string; role: string }) {
    if (reader && !seesWholeVenue(reader.role)) {
      const payment = await this.prisma.payment.findUnique({ where: { id: paymentId }, select: { createdByUserId: true } });
      if (!payment || !mayReadCobro(reader, payment.createdByUserId)) throw new NotFoundException('Payment not found');
    }
    return this.prisma.refund.findMany({
      where: { paymentId },
      orderBy: { createdAt: 'desc' },
    });
  }
}

/**
 * «Por aprobar», otra vez con la fila del cobro bloqueada: el encargado no
 * devuelve directo si con esta lo devuelto por la pasarela en el cobro (por
 * todas las personas) llega al umbral del local. El controlador ya lo miró
 * sin candado; así dos encargados a la vez (o dos pestañas) no pasan los dos
 * por debajo. 409 REFUND_NEEDS_APPROVAL: el controlador la pide al dueño (202).
 */
async function assertBelowApprovalThreshold(
  tx: TransactionalClient,
  payment: { id: string; tenantId: string },
  amountCents: number,
  actor: Actor,
): Promise<void> {
  if (actor.role !== 'MANAGER') return;
  const venue = await tx.venue.findUnique({
    where: { id: payment.tenantId },
    select: { payoutRequiresApproval: true, refundApprovalThresholdCents: true },
  });
  if (!venue) throw new NotFoundException('Local no encontrado');
  const already = await apiRefundedOnPaymentCents(tx, payment.tenantId, payment.id);
  if (refundRoute(actor.role, amountCents, venue, already) === 'request') {
    throw refundNeedsApproval(already + amountCents, venue.refundApprovalThresholdCents);
  }
}

export { BITCOIN_REFUND_CODE, BITCOIN_REFUND_TEXT, assertNotBitcoin } from './bitcoin-refund';
