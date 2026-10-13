import {
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
import { PaymentsService } from '../payments/payments.service';
import { InvalidTransitionError } from '../payments/payment.machine';
import { TotpService } from '../auth/totp.service';
import { AuditService } from '../audit/audit.service';
import { MetricsService } from '../metrics/metrics.service';
import type { Role } from '@nightpay/contracts';
import type { RequestContext } from '../../common/context/request-context';

const TWO_FA_THRESHOLD_CENTS = 100_00; // 100€

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

/** Ventana en la que una devolución del mismo importe se trata como posible repetida. */
const DUPLICATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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

  async refund(
    request: RefundRequest,
    actor: { userId: string; role: Role; tenantId: string },
  ) {
    if (actor.role === 'WAITER') {
      throw new ForbiddenException('WAITER cannot refund');
    }

    // 2FA TOTP requerido para refunds >= 100€ — verificacion REAL con speakeasy
    if (request.amountCents >= TWO_FA_THRESHOLD_CENTS) {
      if (!request.totpCode) {
        throw new ForbiddenException('TOTP required for refunds >= 100 EUR');
      }
      const user = await this.prisma.user.findUnique({
        where: { id: actor.userId },
        select: { totpSecret: true, email: true },
      });
      if (!user?.totpSecret) {
        // El user nunca enrolo TOTP — bloquear refund hasta que lo haga.
        throw new ForbiddenException(
          'TOTP not enrolled for this user — contact owner to enroll before high-value refunds',
        );
      }
      const valid = this.totp.verify(user.totpSecret, request.totpCode);
      if (!valid) {
        this.logger.warn(`TOTP invalid for user ${actor.userId} (${user.email})`);
        throw new ForbiddenException('Invalid TOTP code');
      }
      this.logger.log(`TOTP verified for high-value refund: user=${actor.userId}`);
    }

    // Lookup payment + lock implicit en la transaction de refund
    const payment = await this.prisma.payment.findUnique({
      where: { id: request.paymentId },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.status !== 'AUTHORIZED' && payment.status !== 'PARTIALLY_REFUNDED') {
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

    // 1) Crear registro Refund (PENDING)
    const refund = await this.prisma.refund.create({
      data: {
        tenantId: payment.tenantId,
        paymentId: payment.id,
        amountCents: request.amountCents,
        reason: request.reason,
        requestedBy: actor.userId,
        status: 'PENDING',
      },
    });

    // 2) Llamar a la pasarela (idempotente por refund.id)
    let providerRefundId: string;
    try {
      const adapter = this.gateways.get(payment.provider);
      const result = await adapter.refund({
        tenantId: payment.tenantId,
        paymentId: payment.id,
        providerTxId: payment.providerTxId,
        amountCents: request.amountCents,
        reason: request.reason,
        reference: refund.id,
      });
      providerRefundId = result.providerRefundId;
      if (result.status === 'FAILED') {
        await this.prisma.refund.update({
          where: { id: refund.id },
          data: { status: 'FAILED', providerRefundId },
        });
        this.metrics.refundsCreated.inc({
          venue: payment.tenantId,
          provider: payment.provider,
          status: 'failed',
        });
        throw new ConflictException('Gateway refund failed');
      }
    } catch (err) {
      this.logger.error(`Refund gateway call failed: ${(err as Error).message}`);
      await this.prisma.refund.update({
        where: { id: refund.id },
        data: { status: 'FAILED' },
      });
      this.metrics.refundsCreated.inc({
        venue: payment.tenantId,
        provider: payment.provider,
        status: 'failed',
      });
      if (err instanceof ConflictException) throw err;
      throw new ConflictException('Refund gateway error');
    }

    // 3) Actualizar Refund + transitar FSM (REFUND_PARTIAL puede cubrir todo el saldo)
    await this.prisma.refund.update({
      where: { id: refund.id },
      data: { status: 'SUCCEEDED', providerRefundId },
    });
    this.metrics.refundsCreated.inc({
      venue: payment.tenantId,
      provider: payment.provider,
      status: 'success',
    });

    await this.settleRefund(
      { id: payment.id, tenantId: payment.tenantId },
      refund.id,
      request.amountCents,
      actor,
    );

    // Audit log
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
        providerRefundId,
        twoFactorRequired: request.amountCents >= TWO_FA_THRESHOLD_CENTS,
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
      providerRefundId,
    };
  }

  /**
   * Apunta una devolución que el dueño ya hizo en el portal de BBVA. No toca
   * el banco: ajusta el cobro (importe devolvible y estado) y descuenta la
   * parte de la chica, también si ya se le había pagado (queda como deuda).
   */
  async registerBankRefund(
    request: BankRefundRequest,
    actor: { userId: string; role: Role; tenantId: string },
  ) {
    if (actor.role !== 'OWNER') {
      throw new ForbiddenException('Solo el dueño puede registrar devoluciones del banco');
    }
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
    if (payment.status !== 'AUTHORIZED' && payment.status !== 'PARTIALLY_REFUNDED') {
      throw new ConflictException('Solo se registran devoluciones de cobros pagados');
    }
    if (payment.walletId) {
      // El saldo de la wallet seguiría disponible para gastar.
      throw new ConflictException('Es una recarga de wallet: devuélvela desde la pestaña Wallets');
    }
    if (request.amountCents > payment.availableAmountCents) {
      throw new BadRequestException(
        `La devolución (${eur(request.amountCents)}) supera lo que queda por devolver (${eur(payment.availableAmountCents)})`,
      );
    }
    const refundedAt = request.refundedAt ?? new Date();
    if (refundedAt.getTime() > Date.now() + 60_000) {
      throw new BadRequestException('La fecha de la devolución no puede ser futura');
    }
    // 1) Reserva (PENDING) bajo un candado por cobro: dos registros a la vez
    //    (doble clic) no pasan los dos el control de devoluciones repetidas.
    const refund = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtext(${`refund:${payment.id}`}))`;
      if (!request.confirmDuplicate) {
        const similar = await tx.refund.count({
          where: {
            paymentId: payment.id,
            amountCents: request.amountCents,
            status: { in: ['PENDING', 'SUCCEEDED'] },
            createdAt: { gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
          },
        });
        if (similar > 0) {
          throw new ConflictException(
            `Ya hay una devolución de ${eur(request.amountCents)} registrada en este cobro. Si es otra distinta, confírmalo.`,
          );
        }
      }
      return tx.refund.create({
        data: {
          tenantId: payment.tenantId,
          paymentId: payment.id,
          amountCents: request.amountCents,
          reason: request.reason,
          requestedBy: actor.userId,
          status: 'PENDING',
          providerRefundId: request.bankReference ?? null,
          registeredManually: true,
          bankRefundedAt: refundedAt,
        },
      });
    });

    // 2) Ajuste del cobro bajo su FOR UPDATE: el FSM rechaza devolver más de lo
    //    que queda. Si no cabe, la reserva queda FAILED y no cuenta en nada.
    try {
      await this.payments.transition(
        payment.id,
        { type: 'REFUND_PARTIAL', amountCents: request.amountCents },
        actor.tenantId,
      );
    } catch (err) {
      await this.prisma.refund
        .update({ where: { id: refund.id }, data: { status: 'FAILED' } })
        .catch((e: unknown) =>
          this.logger.error(`No se pudo marcar FAILED la devolución ${refund.id}: ${(e as Error).message}`),
        );
      if (err instanceof InvalidTransitionError) {
        throw new ConflictException(
          'El cobro ya no admite esta devolución (puede que otra se haya registrado a la vez). Recarga la lista.',
        );
      }
      throw err;
    }

    // 3) Hecha: cuenta en informes y descuenta a la chica.
    await this.prisma.refund.update({ where: { id: refund.id }, data: { status: 'SUCCEEDED' } });
    this.metrics.refundsCreated.inc({
      venue: payment.tenantId,
      provider: payment.provider ?? 'NONE',
      status: 'registered',
    });
    await this.reverseEarning(
      { id: payment.id, tenantId: payment.tenantId },
      refund.id,
      request.amountCents,
      actor,
    );

    await this.audit.log({
      action: 'refund.bank_registered',
      tenantId: payment.tenantId,
      actorId: actor.userId,
      targetType: 'Payment',
      targetId: payment.id,
      payload: {
        refundId: refund.id,
        amountCents: request.amountCents,
        bankReference: request.bankReference ?? null,
        refundedAt: refundedAt.toISOString(),
        reason: request.reason,
        confirmedDuplicate: Boolean(request.confirmDuplicate),
      },
    });
    this.logger.log(
      `Devolución BBVA registrada ${refund.id}: ${request.amountCents}c en cobro ${payment.id} por ${actor.userId}`,
    );
    return {
      id: refund.id,
      paymentId: payment.id,
      amountCents: request.amountCents,
      status: 'SUCCEEDED' as const,
      providerRefundId: request.bankReference ?? null,
    };
  }

  /**
   * Tras una devolución ya hecha por la pasarela: estado del cobro
   * (REFUND_PARTIAL puede cubrir todo el saldo) y descuento de la comisión de
   * la chica. El dinero ya se movió, así que un rechazo del FSM solo se avisa.
   */
  private async settleRefund(
    payment: { id: string; tenantId: string },
    refundId: string,
    amountCents: number,
    actor: { userId: string; tenantId: string },
  ): Promise<void> {
    try {
      await this.payments.transition(
        payment.id,
        {
          type: 'REFUND_PARTIAL',
          amountCents,
        },
        actor.tenantId,
      );
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        // Pago ya fue refundeado por race; el Refund ya esta SUCCEEDED, todo bien
        this.logger.warn(`Refund FSM transition rejected (already refunded?): ${err.message}`);
      } else {
        throw err;
      }
    }
    await this.reverseEarning(payment, refundId, amountCents, actor);
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
