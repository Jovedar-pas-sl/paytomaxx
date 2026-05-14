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

    try {
      await this.payments.transition(
        payment.id,
        {
          type: 'REFUND_PARTIAL',
          amountCents: request.amountCents,
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

    // Reverse de la comisión de la operadora (si aplica). Idempotente por refund.id —
    // si el processor reintenta, no duplicamos descuento. Usa accumulator pattern
    // para preservar invariante "total refundeado == amount ⇒ reversed == commission".
    try {
      await this.payments.applyRefundToEarning(
        payment.id,
        refund.id,
        request.amountCents,
      );
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
        `Earning reverse failed for payment ${payment.id} refund ${refund.id} (amount=${request.amountCents}c): ${errorMsg}`,
        err instanceof Error ? err.stack : undefined,
      );
      await this.audit.log({
        action: 'refund.earning_reverse_failed',
        tenantId: payment.tenantId,
        actorId: actor.userId,
        targetType: 'Payment',
        targetId: payment.id,
        payload: {
          refundId: refund.id,
          amountCents: request.amountCents,
          error: errorMsg,
        },
      });
    }

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

  async listForPayment(paymentId: string) {
    return this.prisma.refund.findMany({
      where: { paymentId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
