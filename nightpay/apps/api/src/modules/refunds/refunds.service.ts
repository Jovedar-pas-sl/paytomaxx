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
import { GatewayRegistry } from '../gateways/gateway.registry';
import type { GatewayAdapter } from '../gateways/gateway.adapter';
import { PaymentsService } from '../payments/payments.service';
import { InvalidTransitionError } from '../payments/payment.machine';
import { TotpService } from '../auth/totp.service';
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
  assertNotDuplicateBankRefund,
  assertRefundFits,
  lockPaymentForRefund,
  settlePendingRefund,
} from './refund-ledger';
import { lockRefundsOf, refundTotalsOf, twoFactorReason } from './refund-two-factor';
import type { TransactionalClient } from '../../common/prisma/prisma.service';

/**
 * Una devolución pendiente no se resuelve a mano hasta pasado este rato: la
 * pasarela aún puede estar contestando a la petición original.
 */
const MANUAL_RESOLVE_AFTER_MS = 2 * 60 * 1000;

export interface RefundRequest {
  paymentId: string;
  amountCents: number;
  reason?: string;
  totpCode?: string;
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
  async refund(request: RefundRequest, actor: Actor) {
    if (actor.role === 'WAITER') {
      throw new ForbiddenException('WAITER cannot refund');
    }
    const { payment, adapter } = await this.refundTarget(request);
    const { refund, twoFactorRequired } = await this.reserveApiRefund(payment, request, actor);
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
   * 2FA según lo devuelto ACUMULADO por esta persona (mismo cobro y últimas
   * 24 h), no por petición: 99,99 € × N ya no lo esquiva. Se decide dentro de
   * la transacción de la reserva, con su candado por persona tomado, así que
   * dos peticiones suyas a la vez no pasan las dos por debajo del umbral.
   * Devuelve si se pidió el código.
   */
  private async checkTwoFactor(
    tx: TransactionalClient,
    request: RefundRequest,
    actor: Actor,
  ): Promise<boolean> {
    const totals = await refundTotalsOf(tx, actor, request.paymentId);
    const reason = twoFactorReason(request.amountCents, totals);
    if (!reason) return false;
    if (!request.totpCode) {
      throw new ForbiddenException({
        message: `Hace falta el código 2FA: ${reason} devueltos (desde 100 € se pide).`,
        code: 'TOTP_REQUIRED',
      });
    }
    const user = await tx.user.findUnique({
      where: { id: actor.userId },
      select: { totpSecret: true, email: true },
    });
    if (!user?.totpSecret) {
      throw new ForbiddenException({
        message:
          'Para devolver desde 100 € hace falta la app de verificación (2FA) y no la tienes activada: pide al dueño que te la active.',
        code: 'TOTP_NOT_ENROLLED',
      });
    }
    if (!this.totp.verify(user.totpSecret, request.totpCode)) {
      this.logger.warn(`TOTP invalid for user ${actor.userId} (${user.email})`);
      throw new ForbiddenException({ message: 'Código 2FA incorrecto o caducado', code: 'TOTP_INVALID' });
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
    if (payment.walletId) {
      throw new ConflictException('Es una recarga de saldo: se devuelve desde Wallets → Devolver saldo');
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
  private async reserveApiRefund(payment: RefundTarget, request: RefundRequest, actor: Actor) {
    return this.prisma.$transaction(async (tx) => {
      await lockRefundsOf(tx, actor.userId);
      const locked = await lockPaymentForRefund(tx, payment.id);
      if (!locked || !REFUNDABLE_STATUSES.has(locked.status)) {
        throw new ConflictException(`Cannot refund payment in state ${locked?.status ?? 'desconocido'}`);
      }
      // Primero si cabe (no se pide un código para algo imposible), luego el 2FA.
      await assertRefundFits(tx, payment.id, locked, request.amountCents);
      const twoFactorRequired = await this.checkTwoFactor(tx, request, actor);
      const refund = await tx.refund.create({
        data: {
          tenantId: payment.tenantId,
          paymentId: payment.id,
          amountCents: request.amountCents,
          reason: request.reason,
          requestedBy: actor.userId,
          status: 'PENDING',
        },
      });
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
    this.logger.error(`Refund ${refundId} no hecha por la pasarela (${outcome.why}): ${outcome.reason}`);
    await this.prisma.refund.update({
      where: { id: refundId },
      data: {
        status: 'FAILED',
        ...(outcome.providerRefundId ? { providerRefundId: outcome.providerRefundId } : {}),
      },
    });
    this.metrics.refundsCreated.inc({ venue: payment.tenantId, provider: payment.provider, status: 'failed' });
    throw new ConflictException(REJECTED_MESSAGES[outcome.why]);
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
    if (outcome.providerRefundId) {
      await this.prisma.refund.update({ where: { id: refundId }, data: { providerRefundId: outcome.providerRefundId } });
    }
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
    throw new BadGatewayException({
      message:
        'No sabemos si la pasarela ha hecho la devolución. Queda pendiente (y reservada) para que no se repita: ' +
        'mírala en el portal de la pasarela y márcala como hecha o no hecha en el cobro.',
      code: 'REFUND_OUTCOME_UNKNOWN',
      refundId,
    });
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
        prepare: (tx) => settlePendingRefund(tx, refundId, { status: 'SUCCEEDED', providerRefundId }),
      });
    } catch (err) {
      await this.flagSettleFailed(payment, refundId, amountCents, actor, err);
      if (err instanceof InvalidTransitionError || err instanceof ConflictException) {
        throw new ConflictException({
          message:
            'La pasarela ha hecho la devolución, pero el cobro no admite apuntarla. ' +
            'Queda pendiente de revisar en Incidencias: no la repitas.',
          code: 'REFUND_SETTLE_REJECTED',
          refundId,
        });
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
    const refundedAt = request.refundedAt ?? new Date();
    if (refundedAt.getTime() > Date.now() + 60_000) {
      throw new BadRequestException('La fecha de la devolución no puede ser futura');
    }
    const refundId = randomUUID();
    await this.applyBankRefund(payment, refundId, { ...request, refundedAt }, actor, opts);

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
      },
    });
    if (!payment || payment.tenantId !== actor.tenantId) throw new NotFoundException('Payment not found');
    if (!REFUNDABLE_STATUSES.has(payment.status)) {
      throw new ConflictException('Solo se registran devoluciones de cobros pagados');
    }
    if (payment.walletId && !opts.walletPayout) {
      // El saldo de la wallet seguiría disponible para gastar.
      throw new ConflictException('Es una recarga de wallet: devuélvela desde la pestaña Wallets');
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
            await assertRefundFits(tx, payment.id, locked, request.amountCents);
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
        { prepare: (tx) => settlePendingRefund(tx, refund.id, { status: 'SUCCEEDED' }) },
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
      this.metrics.earningReversalFailed.inc({
        venue: payment.tenantId,
        payment_id: payment.id,
      });
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

  async listForPayment(paymentId: string) {
    return this.prisma.refund.findMany({
      where: { paymentId },
      orderBy: { createdAt: 'desc' },
    });
  }
}

function eur(cents: number): string {
  return `${(cents / 100).toFixed(2).replace('.', ',')} €`;
}
