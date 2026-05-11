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
import { WalletsService } from '../wallets/wallets.service';

const QR_TTL_SECONDS = 5 * 60; // 5 min
const POS_QR_TTL_SECONDS = 30 * 60; // 30 min — camarero tiene tiempo de llegar
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
  private readonly wallets: WalletsService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(ClsService) cls: ClsService<{ ctx: RequestContext }>,
    @InjectQueue(QR_EXPIRE_QUEUE) qrExpireQueue: Queue,
    @InjectQueue(ORPHAN_RECONCILE_QUEUE) orphanReconcileQueue: Queue,
    @Inject(GatewayRegistry) gateways: GatewayRegistry,
    @Inject(RealtimeGateway) realtime: RealtimeGateway,
    @Inject(MetricsService) metrics: MetricsService,
    @Inject(WalletsService) wallets: WalletsService,
  ) {
    this.prisma = prisma;
    this.cls = cls;
    this.qrExpireQueue = qrExpireQueue;
    this.orphanReconcileQueue = orphanReconcileQueue;
    this.gateways = gateways;
    this.realtime = realtime;
    this.metrics = metrics;
    this.wallets = wallets;
  }

  /**
   * Crea un pago. Idempotente: misma idempotencyKey + tenantId → mismo pago.
   */
  async create(
    tenantId: string,
    idempotencyKey: string,
    dto: CreatePaymentDto,
    actor?: { userId: string; role: string },
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
    // Excepciones al cap:
    //  - Wallet top-up: el cliente decide cuánto cargar (prepago); el cap
    //    de cobros puntuales no aplica.
    //  - Otros modos (QR cliente, POS_EXTERNAL): cap normal aplica como
    //    protección contra typos.
    const ctx = this.cls.get('ctx');
    const creatorUserId = actor?.userId ?? ctx?.userId ?? null;
    const creatorRole = actor?.role ?? ctx?.role;
    const isWalletTopUp = Boolean(dto.wallet);
    if (creatorRole === 'OPERATOR' && !isWalletTopUp) {
      const venue = await this.prisma.asSystem((tx) =>
        tx.venue.findUniqueOrThrow({
          where: { id: tenantId },
          select: { operatorMaxCobroCents: true },
        }),
      );
      if (dto.amountCents > venue.operatorMaxCobroCents) {
        throw new BadRequestException(
          `Importe ${dto.amountCents / 100} € supera el límite del local (${venue.operatorMaxCobroCents / 100} €). ` +
            `Para wallet top-up no aplica el cap; para cobros puntuales pídele al OWNER que suba el cap en Ajustes.`,
        );
      }
    }

    // 2c. Phase 1B — si dto.wallet, resolver walletId antes de crear el payment.
    // create:true → crea wallet vacía + usa su id. walletId:<id> → valida pertenencia.
    let resolvedWalletId: string | null = null;
    const walletDto = dto.wallet;
    if (walletDto) {
      if ('create' in walletDto && walletDto.create) {
        const created = await this.wallets.createEmpty({
          tenantId,
          identifier: walletDto.identifier ?? null,
        });
        resolvedWalletId = created.id;
      } else if ('walletId' in walletDto) {
        const existing = await this.prisma.asSystem((tx) =>
          tx.clientWallet.findFirst({
            where: { id: walletDto.walletId, tenantId },
            select: { id: true, status: true },
          }),
        );
        if (!existing) {
          throw new NotFoundException('Wallet no encontrada en este venue');
        }
        if (existing.status !== 'ACTIVE') {
          throw new BadRequestException(`Wallet en status ${existing.status} — no se puede recargar`);
        }
        resolvedWalletId = existing.id;
      }
    }

    // 3. Crear payment + evento inicial — atómico
    const qrToken = randomUUID();
    // POS_EXTERNAL puede tardar más en confirmarse (camarero camina con el
    // datáfono) — TTL más generoso. Wallet topup y QR normal: 5 min default.
    const isPosExternal = dto.captureMethod === 'POS_EXTERNAL';
    const ttlSeconds = isPosExternal ? POS_QR_TTL_SECONDS : QR_TTL_SECONDS;
    const qrExpiresAt = new Date(Date.now() + ttlSeconds * 1000);

    // Mutex: no se puede top-upear wallet via POS_EXTERNAL (PSP externo no nos
    // notifica AUTHORIZED por webhook → no podríamos creditar el wallet).
    if (isPosExternal && resolvedWalletId) {
      throw new BadRequestException(
        'No se puede cargar wallet vía POS externo — usa modo QR normal.',
      );
    }

    const effectiveCaptureMethod = resolvedWalletId
      ? 'WALLET_TOPUP'
      : dto.captureMethod ?? null;

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
          ...(effectiveCaptureMethod ? { captureMethod: effectiveCaptureMethod } : {}),
          ...(resolvedWalletId ? { walletId: resolvedWalletId } : {}),
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
            walletId: resolvedWalletId,
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
            walletId: string | null;
          }>
        >`
          SELECT id, "tenantId", status, "amountCents", "availableAmountCents",
                 "providerTxId", provider, "createdByUserId", "walletId"
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

        // Phase 1B — hook de crédito a wallet: si el payment está ligado a una
        // ClientWallet (top-up flow) y transitamos a AUTHORIZED, sumamos el importe
        // al balance ATÓMICAMENTE en la misma transacción de la FSM. Lock con
        // SELECT FOR UPDATE evita race con consumes simultáneos.
        if (result.nextState === 'AUTHORIZED' && p.walletId) {
          const walletLocked = await tx.$queryRaw<
            Array<{ id: string; balanceCents: number; status: string }>
          >`
            SELECT id, "balanceCents", status FROM client_wallets
             WHERE id = ${p.walletId}::uuid FOR UPDATE
          `;
          const w = walletLocked[0];
          if (w && w.status === 'ACTIVE') {
            await tx.$executeRaw`
              UPDATE client_wallets
                 SET "balanceCents" = "balanceCents" + ${p.amountCents}::int,
                     "updatedAt" = now()
               WHERE id = ${p.walletId}::uuid
            `;
            this.logger.log(
              `Payment ${paymentId} AUTHORIZED → wallet ${p.walletId} credited +${p.amountCents}c (new balance: ${w.balanceCents + p.amountCents})`,
            );
          } else {
            this.logger.warn(
              `Payment ${paymentId} AUTHORIZED but wallet ${p.walletId} not creditable (status=${w?.status ?? 'missing'}). Manual review needed.`,
            );
          }
        }

        // Hook de earning para OPERATOR — si transitamos a AUTHORIZED y el creador
        // del payment es una operadora, snapshot de comisión en operator_earnings.
        // Idempotente: la unique en paymentId rechaza un segundo insert (defensa
        // contra una transición duplicada que la FSM ya filtra).
        // NOTA: si p.walletId está set, NO generamos earning aquí — el earning
        // se genera per-consumption en wallets.service (chica cobra granular).
        if (result.nextState === 'AUTHORIZED' && p.createdByUserId && !p.walletId) {
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
   * Camarero/manager confirma que cobró un Payment POS_EXTERNAL en el datáfono.
   * Solo válido para payments con captureMethod=POS_EXTERNAL en estado CREATED.
   * El que confirma debe ser WAITER/MANAGER/OWNER — NO el mismo OPERATOR que
   * creó el cobro (anti auto-confirm).
   */
  async confirmPosPayment(
    paymentId: string,
    actor: { userId: string; role: string },
    dto: { posReceiptRef?: string; notes?: string },
  ): Promise<{ status: PaymentMachineState }> {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Payment not found');

    if (payment.captureMethod !== 'POS_EXTERNAL') {
      throw new ConflictException(
        `Este cobro no es POS_EXTERNAL (captureMethod=${payment.captureMethod}). Solo POS se confirma manual.`,
      );
    }
    if (payment.status !== 'CREATED') {
      throw new ConflictException(
        `Payment está en ${payment.status} — solo se puede confirmar CREATED`,
      );
    }
    // Anti auto-confirm: la chica no se confirma sus propios POS (camarero sí).
    if (actor.role === 'OPERATOR' && payment.createdByUserId === actor.userId) {
      throw new ForbiddenException(
        'No puedes confirmar tu propio cobro POS. Llama al camarero.',
      );
    }

    try {
      await this.transition(paymentId, {
        type: 'POS_CONFIRMED',
        posReceiptRef: dto.posReceiptRef,
      });
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        throw new ConflictException(
          `Payment cannot be confirmed in state ${payment.status}`,
        );
      }
      throw err;
    }

    // Audit log con el camarero como actor — la comisión se generó en transition()
    // via el hook earning normal (createdByUserId apunta a la chica).
    this.logger.log(
      `Payment ${paymentId} POS_CONFIRMED by ${actor.role}=${actor.userId} ref=${dto.posReceiptRef ?? '-'}`,
    );

    return { status: 'AUTHORIZED' };
  }

  /**
   * Lista cobros POS pendientes (status=CREATED + captureMethod=POS_EXTERNAL)
   * para el panel del camarero. Tenant-scoped vía CLS.
   */
  async listPendingPos(tenantId: string) {
    const rows = await this.prisma.payment.findMany({
      where: {
        tenantId,
        status: 'CREATED',
        captureMethod: 'POS_EXTERNAL',
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        createdBy: { select: { displayName: true, email: true } },
      },
    });
    return rows.map((p) => ({
      id: p.id,
      amountCents: p.amountCents,
      currency: p.currency,
      createdAt: p.createdAt.toISOString(),
      qrExpiresAt: p.qrExpiresAt.toISOString(),
      createdByName: p.createdBy?.displayName ?? p.createdBy?.email ?? '—',
      qrToken: p.qrToken,
      // Código corto humano-legible para referenciar verbalmente
      refCode: p.id.slice(-6).toUpperCase(),
    }));
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
    const p = await this.prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: { wallet: { select: { qrToken: true } } },
    });
    const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? 4100}`;
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
      // Phase 1B — si el pago tiene wallet ligado, exponemos su id + qrToken
      // para que el frontend pueda redirigir al cliente a su balance page.
      walletId: p.walletId ?? null,
      walletQrToken: p.wallet?.qrToken ?? null,
    };
  }
}
