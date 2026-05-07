import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import * as QRCode from 'qrcode';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  applyEvent,
  InvalidTransitionError,
  type PaymentEvent,
  type PaymentMachineState,
} from './payment.machine';
import type { CreatePaymentDto, CreatedPaymentResponse, PublicPaymentView } from '@nightpay/contracts';
import type { RequestContext } from '../../common/context/request-context';
import { QR_EXPIRE_QUEUE, ORPHAN_RECONCILE_QUEUE } from '../queues/queue-tokens';
import { GatewayRegistry } from '../gateways/gateway.registry';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { MetricsService } from '../metrics/metrics.service';

const QR_TTL_SECONDS = 5 * 60; // 5 min
const ORPHAN_RECONCILE_DELAY_MS = 30 * 60 * 1000; // 30 min sin webhook → reconcile

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly prisma: PrismaService;
  private readonly cls: ClsService<{ ctx: RequestContext }>;
  private readonly qrExpireQueue: Queue;
  private readonly orphanReconcileQueue: Queue;
  private readonly gateways: GatewayRegistry;
  private readonly realtime: RealtimeGateway;
  private readonly metrics: MetricsService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(ClsService) cls: ClsService<{ ctx: RequestContext }>,
    @InjectQueue(QR_EXPIRE_QUEUE) qrExpireQueue: Queue,
    @InjectQueue(ORPHAN_RECONCILE_QUEUE) orphanReconcileQueue: Queue,
    @Inject(GatewayRegistry) gateways: GatewayRegistry,
    @Inject(RealtimeGateway) realtime: RealtimeGateway,
    @Inject(MetricsService) metrics: MetricsService,
  ) {
    this.prisma = prisma;
    this.cls = cls;
    this.qrExpireQueue = qrExpireQueue;
    this.orphanReconcileQueue = orphanReconcileQueue;
    this.gateways = gateways;
    this.realtime = realtime;
    this.metrics = metrics;
  }

  /**
   * Crea un pago. Idempotente: misma idempotencyKey + tenantId → mismo pago.
   */
  async create(
    tenantId: string,
    idempotencyKey: string,
    dto: CreatePaymentDto,
  ): Promise<CreatedPaymentResponse> {
    // 1. Idempotency: si ya existe pago con esta key, devuélvelo
    const existing = await this.prisma.payment.findUnique({
      where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } },
    });
    if (existing) {
      this.logger.log(`Idempotent hit: key=${idempotencyKey} → payment=${existing.id}`);
      return this.toCreatedResponse(existing.id);
    }

    // 2. Validar terminal — by externalId
    const terminal = await this.prisma.terminal.findUnique({
      where: { tenantId_externalId: { tenantId, externalId: dto.terminalExternalId } },
    });
    if (!terminal || !terminal.active) {
      throw new BadRequestException(`Terminal '${dto.terminalExternalId}' not found or inactive`);
    }

    // 2b. Si el creador es OPERATOR, validar cap del venue. Owner/Manager lo ignoran.
    const ctx = this.cls.get('ctx');
    const creatorUserId = ctx?.userId ?? null;
    if (ctx?.role === 'OPERATOR') {
      const venue = await this.prisma.asSystem((tx) =>
        tx.venue.findUniqueOrThrow({
          where: { id: tenantId },
          select: { operatorMaxCobroCents: true },
        }),
      );
      if (dto.amountCents > venue.operatorMaxCobroCents) {
        throw new BadRequestException(
          `Importe ${dto.amountCents / 100} € supera el límite del local (${venue.operatorMaxCobroCents / 100} €).`,
        );
      }
    }

    // 3. Crear payment + evento inicial — atómico
    const qrToken = randomUUID();
    const qrExpiresAt = new Date(Date.now() + QR_TTL_SECONDS * 1000);

    const payment = await this.prisma.$transaction(async (tx) => {
      const p = await tx.payment.create({
        data: {
          tenantId,
          terminalId: terminal.id,
          createdByUserId: creatorUserId,
          idempotencyKey,
          amountCents: dto.amountCents,
          availableAmountCents: dto.amountCents,
          currency: dto.currency,
          status: 'CREATED',
          qrToken,
          qrExpiresAt,
        },
      });
      await tx.paymentEvent.create({
        data: {
          paymentId: p.id,
          tenantId,
          eventType: 'payment.created',
          payload: {
            amountCents: p.amountCents,
            terminal: dto.terminalExternalId,
          },
          traceId: this.cls.get('ctx')?.traceId ?? randomUUID(),
        },
      });
      return p;
    });

    // 4. Encolar job de expiración (id determinista → idempotente al encolar)
    await this.qrExpireQueue.add(
      'qr-expire',
      { paymentId: payment.id, tenantId },
      {
        jobId: `qr-expire-${payment.id}`,
        delay: QR_TTL_SECONDS * 1000,
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );

    this.metrics.paymentsCreated.inc({ venue: tenantId, provider: 'pending' });
    this.logger.log(`Payment created ${payment.id} amount=${payment.amountCents} venue=${tenantId}`);
    return this.toCreatedResponse(payment.id);
  }

  /**
   * Lookup público por qrToken (cliente escanea, sin auth).
   */
  async getByToken(qrToken: string): Promise<PublicPaymentView> {
    // Cross-tenant: el token es público pero único; bypass RLS
    const payment = await this.prisma.asSystem((tx) =>
      tx.payment.findUnique({
        where: { qrToken },
        include: {
          venue: { select: { name: true } },
          terminal: { select: { label: true } },
        },
      }),
    );
    if (!payment) throw new NotFoundException('QR not found or expired');

    return {
      id: payment.id,
      amountCents: payment.amountCents,
      currency: payment.currency,
      status: payment.status,
      venueName: payment.venue.name,
      terminalLabel: payment.terminal.label,
      qrExpiresAt: payment.qrExpiresAt.toISOString(),
    };
  }

  /**
   * Detalle completo (admin/manager vía AuthGuard + tenant filter).
   */
  async findById(paymentId: string) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Payment not found');
    return payment;
  }

  /**
   * Ejecuta una transición FSM atómica con SELECT ... FOR UPDATE.
   * Persiste el cambio de estado + evento en payment_events.
   *
   * Llamadores típicos: webhook processor, qr-expire job, refund flow.
   */
  async transition(paymentId: string, event: PaymentEvent): Promise<void> {
    // transition() es interna (workers + refunds futuros). Usamos SQL crudo end-to-end
    // para evitar interaccion ambigua con el middleware de tenant: el lock pesimista
    // y el UPDATE deben ir sobre la MISMA fila. Cualquier filtro adicional del
    // middleware podria desincronizar la lectura del lock con la escritura.
    let nextState: PaymentMachineState | undefined;
    let prevState: PaymentMachineState | undefined;
    let amountCents = 0;

    await this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<
          Array<{
            id: string;
            tenantId: string;
            status: PaymentMachineState;
            amountCents: number;
            availableAmountCents: number;
            providerTxId: string | null;
            provider: 'WIPAY' | 'PEANPE' | null;
            createdByUserId: string | null;
          }>
        >`
          SELECT id, "tenantId", status, "amountCents", "availableAmountCents",
                 "providerTxId", provider, "createdByUserId"
            FROM payments
           WHERE id = ${paymentId}::uuid
           FOR UPDATE
        `;

        const p = rows[0];
        if (!p) throw new NotFoundException(`Payment ${paymentId} not found`);

        const result = applyEvent(
          p.status,
          {
            paymentId: p.id,
            amountCents: p.amountCents,
            availableAmountCents: p.availableAmountCents,
            providerTxId: p.providerTxId ?? undefined,
            provider: p.provider ?? undefined,
          },
          event,
        );

        if (!result) {
          this.logger.warn(`FSM rejected: ${event.type} on ${p.status} (payment=${paymentId})`);
          throw new InvalidTransitionError(p.status, event.type);
        }

        // UPDATE crudo — bypasa el middleware del cliente (no inyecta tenantId).
        // La fila ya esta locked por id (UUID); seguro.
        await tx.$executeRaw`
          UPDATE payments
             SET status = ${result.nextState}::"PaymentStatus",
                 "availableAmountCents" = ${result.nextContext.availableAmountCents},
                 "providerTxId" = ${result.nextContext.providerTxId ?? p.providerTxId},
                 provider = ${(result.nextContext.provider ?? p.provider) as 'WIPAY' | 'PEANPE' | null}::"Provider",
                 "updatedAt" = NOW()
           WHERE id = ${paymentId}::uuid
        `;

        // INSERT crudo en payment_events tambien — mismo motivo.
        const traceId = this.cls.get('ctx')?.traceId ?? randomUUID();
        await tx.$executeRaw`
          INSERT INTO payment_events ("paymentId", "tenantId", "eventType", payload, "traceId")
          VALUES (
            ${paymentId}::uuid,
            ${p.tenantId}::uuid,
            ${`payment.${event.type.toLowerCase()}`},
            ${JSON.stringify(event)}::jsonb,
            ${traceId}
          )
        `;

        // Hook de earning para OPERATOR — si transitamos a AUTHORIZED y el creador
        // del payment es una operadora, snapshot de comisión en operator_earnings.
        // Idempotente: la unique en paymentId rechaza un segundo insert (defensa
        // contra una transición duplicada que la FSM ya filtra).
        if (result.nextState === 'AUTHORIZED' && p.createdByUserId) {
          const creatorRows = await tx.$queryRaw<
            Array<{ id: string; role: string; commissionBps: number | null }>
          >`
            SELECT id, role::text AS role, "commissionBps"
              FROM users
             WHERE id = ${p.createdByUserId}::uuid
          `;
          const creator = creatorRows[0];
          if (creator?.role === 'OPERATOR' && creator.commissionBps !== null) {
            const bps = creator.commissionBps;
            const commissionCents = Math.floor((p.amountCents * bps) / 10_000);
            await tx.$executeRaw`
              INSERT INTO operator_earnings (
                "tenantId", "operatorId", "paymentId",
                "paymentAmountCents", "commissionBps", "commissionCents"
              )
              VALUES (
                ${p.tenantId}::uuid,
                ${creator.id}::uuid,
                ${paymentId}::uuid,
                ${p.amountCents}::int,
                ${bps}::int,
                ${commissionCents}::int
              )
              ON CONFLICT ("paymentId") DO NOTHING
            `;
          }
        }

        prevState = p.status;
        nextState = result.nextState;
        amountCents = p.amountCents;
      },
      { isolationLevel: 'ReadCommitted' },
    );

    if (prevState && nextState) {
      this.metrics.paymentsTransitioned.inc({ from: prevState, to: nextState });
    }
    this.logger.log(`Payment ${paymentId} transitioned via ${event.type}`);

    // Emit WS DESPUES del commit — si el cliente reconecta y pide estado,
    // ya esta persistido. Antes de commit habria riesgo de fantasma.
    if (nextState) {
      this.realtime.emitPaymentUpdate(paymentId, nextState, amountCents);
      if (
        nextState === 'AUTHORIZED' ||
        nextState === 'FAILED' ||
        nextState === 'EXPIRED' ||
        nextState === 'CANCELED'
      ) {
        this.realtime.emitPaymentCompleted(paymentId, nextState);
      }
    }
  }

  /**
   * Cancela un pago en estado CREATED|AWAITING_CAPTURE.
   * - OPERATOR solo puede cancelar payments creados por ella.
   * - OWNER/MANAGER pueden cancelar cualquier payment del venue.
   * Returns 409 si el FSM no permite (estado terminal).
   */
  async cancel(
    paymentId: string,
    actor: { userId: string; role: string },
  ): Promise<{ status: PaymentMachineState }> {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Payment not found');

    if (actor.role === 'OPERATOR' && payment.createdByUserId !== actor.userId) {
      throw new ForbiddenException('No puedes cancelar cobros de otra operadora');
    }

    try {
      await this.transition(paymentId, { type: 'CANCELED', reason: 'user-canceled' });
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        throw new ConflictException(
          `Payment cannot be canceled in state ${payment.status}`,
        );
      }
      throw err;
    }
    return { status: 'CANCELED' };
  }

  /**
   * Inicia la autorizacion en la pasarela. Llamado desde el endpoint publico
   * cuando el cliente confirma "voy a pagar" en la pantalla del QR.
   *
   * Flujo:
   *   CREATED|AWAITING_CAPTURE → AUTHORIZING (FSM)
   *   ↓
   *   gateway.authorize() (mock o real)
   *   ↓
   *   pasarela responde inmediato con providerTxId (PROCESSING)
   *   ↓
   *   webhook llegará despues → FSM AUTHORIZED/FAILED
   *
   * Si el pago ya está en AUTHORIZING o terminal → 409.
   */
  async startAuthorization(
    qrToken: string,
  ): Promise<{ status: PaymentMachineState; providerTxId?: string }> {
    // Lookup cross-tenant del pago via token (el cliente no esta autenticado)
    const payment = await this.prisma.asSystem((tx) =>
      tx.payment.findUnique({ where: { qrToken } }),
    );
    if (!payment) throw new NotFoundException('Payment not found');

    if (payment.qrExpiresAt < new Date()) {
      throw new ConflictException('QR expired');
    }

    // Resolver provider activo del venue
    const credential = await this.prisma.asSystem((tx) =>
      tx.gatewayCredential.findFirst({
        where: { tenantId: payment.tenantId, active: true },
        orderBy: { createdAt: 'asc' },
      }),
    );
    if (!credential) {
      throw new ConflictException('Venue has no active gateway credential');
    }

    // 1) Mover FSM a AUTHORIZING — fuente de verdad atomica.
    //    Si otra request ya lo movio, esto lanza InvalidTransitionError → 409.
    try {
      await this.transition(payment.id, { type: 'AUTHORIZING' });
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        throw new ConflictException(`Payment cannot start authorization (already in progress?)`);
      }
      throw err;
    }

    // 2) Pre-persistir provider+placeholder providerTxId — cierra ventana donde
    //    orphan-reconcile podria correr con providerTxId null si el authorize falla
    //    antes de persistir el txId real. Se sobrescribe con el real abajo.
    await this.prisma.asSystem((tx) =>
      tx.payment.update({
        where: { id: payment.id },
        data: { provider: credential.provider },
      }),
    );

    // 3) Llamar a la pasarela (con timeouts y circuit breaker — ver adapter)
    let providerTxId: string;
    try {
      const adapter = this.gateways.get(credential.provider);
      const result = await adapter.authorize({
        tenantId: payment.tenantId,
        paymentId: payment.id,
        amountCents: payment.amountCents,
        currency: payment.currency,
        terminalExternalId: '',
        reference: payment.id,
      });
      providerTxId = result.providerTxId;
    } catch (err) {
      this.logger.error(`Gateway authorize failed for ${payment.id}: ${(err as Error).message}`);
      // Saga: si la pasarela rechaza inmediatamente, marcar FAILED.
      try {
        await this.transition(payment.id, { type: 'FAILED', reason: 'gateway-authorize-error' });
      } catch (e2) {
        if (!(e2 instanceof InvalidTransitionError)) throw e2;
      }
      throw new ConflictException('Gateway temporarily unavailable');
    }

    // 4) Persistir providerTxId real
    await this.prisma.asSystem((tx) =>
      tx.payment.update({
        where: { id: payment.id },
        data: { providerTxId },
      }),
    );

    // 5) Encolar orphan-reconcile (se autocancela si llega webhook antes)
    await this.orphanReconcileQueue.add(
      'orphan-reconcile',
      { paymentId: payment.id, tenantId: payment.tenantId },
      {
        jobId: `orphan-${payment.id}`,
        delay: ORPHAN_RECONCILE_DELAY_MS,
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );

    this.logger.log(
      `Payment ${payment.id} authorizing via ${credential.provider} (txId=${providerTxId})`,
    );
    return { status: 'AUTHORIZING', providerTxId };
  }

  /**
   * Reverse proporcional de la comisión cuando hay refund (parcial o total).
   * Llamado por RefundsService después de que el refund llega a SUCCEEDED.
   *
   * Idempotente respecto a refund.id: el caller debe asegurarse de no llamar
   * dos veces con el mismo refundAmountCents — aquí solo sumamos al
   * reversedCents del earning ligado al payment.
   *
   * Permite saldo negativo (deuda) si reversedCents > commissionCents.
   */
  async applyRefundToEarning(
    paymentId: string,
    refundAmountCents: number,
  ): Promise<void> {
    if (refundAmountCents <= 0) return;
    await this.prisma.$transaction(async (tx) => {
      const earning = await tx.$queryRaw<
        Array<{ commissionBps: number; commissionCents: number; reversedCents: number }>
      >`
        SELECT "commissionBps", "commissionCents", "reversedCents"
          FROM operator_earnings
         WHERE "paymentId" = ${paymentId}::uuid
         FOR UPDATE
      `;
      if (earning.length === 0) return;
      const e = earning[0]!;
      const reverseCents = Math.floor((refundAmountCents * e.commissionBps) / 10_000);
      await tx.$executeRaw`
        UPDATE operator_earnings
           SET "reversedCents" = "reversedCents" + ${reverseCents}::int
         WHERE "paymentId" = ${paymentId}::uuid
      `;
      this.logger.log(
        `Earning reversal payment=${paymentId} refundAmount=${refundAmountCents} reverse=${reverseCents} (bps=${e.commissionBps})`,
      );
    });
  }

  // ─── helpers ───────────────────────────────────────────────────────

  private async toCreatedResponse(paymentId: string): Promise<CreatedPaymentResponse> {
    // CLS ya tiene tenantId del request (AuthGuard lo seteo). El middleware de
    // Prisma inyecta WHERE tenantId — y como el pago lo acabamos de crear con
    // ese mismo tenant, la query devuelve el registro correcto.
    const p = await this.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? 4100}`;
    // Construye URL del QR — apunta al frontend cliente
    const clientUrl =
      process.env.NEXT_PUBLIC_WEB_CLIENT_URL ?? baseUrl.replace(/:\d+$/, ':4101');
    const qrUrl = `${clientUrl}/pay/${p.qrToken}`;
    const qrPngDataUrl = await QRCode.toDataURL(qrUrl, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 320,
    });

    return {
      id: p.id,
      amountCents: p.amountCents,
      currency: p.currency,
      status: p.status,
      qrToken: p.qrToken,
      qrUrl,
      qrPngDataUrl,
      qrExpiresAt: p.qrExpiresAt.toISOString(),
      createdAt: p.createdAt.toISOString(),
    };
  }
}
