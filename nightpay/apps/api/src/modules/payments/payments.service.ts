import {
  BadRequestException,
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
import { QR_EXPIRE_QUEUE } from '../queues/queue-tokens';

const QR_TTL_SECONDS = 5 * 60; // 5 min

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly prisma: PrismaService;
  private readonly cls: ClsService<{ ctx: RequestContext }>;
  private readonly qrExpireQueue: Queue;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(ClsService) cls: ClsService<{ ctx: RequestContext }>,
    @InjectQueue(QR_EXPIRE_QUEUE) qrExpireQueue: Queue,
  ) {
    this.prisma = prisma;
    this.cls = cls;
    this.qrExpireQueue = qrExpireQueue;
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

    // 3. Crear payment + evento inicial — atómico
    const qrToken = randomUUID();
    const qrExpiresAt = new Date(Date.now() + QR_TTL_SECONDS * 1000);

    const payment = await this.prisma.$transaction(async (tx) => {
      const p = await tx.payment.create({
        data: {
          tenantId,
          terminalId: terminal.id,
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
          }>
        >`
          SELECT id, "tenantId", status, "amountCents", "availableAmountCents",
                 "providerTxId", provider
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
      },
      { isolationLevel: 'ReadCommitted' },
    );

    this.logger.log(`Payment ${paymentId} transitioned via ${event.type}`);
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
