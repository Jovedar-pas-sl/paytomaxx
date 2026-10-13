import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { ClsService } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import * as QRCode from 'qrcode';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
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
import { PeanpeAdapter } from '../gateways/peanpe.adapter';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { MetricsService } from '../metrics/metrics.service';
import {
  resolveBpsForOperator,
  resolveRevenueCategory,
  type OperatorCommissionDefaults,
  type RevenueCategory,
} from './commission';
import { WalletsService } from '../wallets/wallets.service';
import { applyServiceItem } from './service-item';
import type { Provider } from '@nightpay/contracts';
import {
  PAID_STATES,
  choosePayPage,
  decideRedsysRetry,
  freshPendingOrder,
  retryOutcome,
  settledPayView,
  type CheckoutChoice,
  type PayablePayment,
  type PayMethodChoice,
  type PayRedirect,
  type PayReceiptView,
  type PayResultView,
  type RetryDecision,
} from './pay-redirect';
import { defaultTipGoesTo, readChargedTip, settleChargedTip, tipOptionsFor } from './tip';
import { BRAND_NAME } from '../../common/brand';

const SERVICE_ITEM_ERRORS: Record<'inactive' | 'role-not-allowed' | 'invalid-category', string> = {
  inactive: 'Ese servicio está desactivado en la carta',
  'role-not-allowed':
    'Desde tu app solo puedes cobrar tus servicios. La barra, la habitación y la comida las cobra el camarero desde la caja.',
  'invalid-category': 'Ese servicio tiene una categoría no válida. Revísalo en la carta del panel.',
};

/** Fila del cobro bloqueada (FOR UPDATE) dentro de transition(). */
export interface LockedPaymentRow {
  id: string;
  tenantId: string;
  status: PaymentMachineState;
  amountCents: number;
  availableAmountCents: number;
  providerTxId: string | null;
  provider: 'WIPAY' | 'PEANPE' | 'PAYTEF' | 'REDSYS' | null;
  createdByUserId: string | null;
  walletId: string | null;
  tipCents: number;
  tipGoesTo: string | null;
  tipBeneficiaryUserId: string | null;
  revenueCategory: string;
}

export interface TransitionOptions {
  /**
   * Se ejecuta con la fila ya bloqueada, antes de aplicar el evento: escribe
   * en la misma transacción y devuelve los campos que cambia (propina,
   * pasarela…) para que la transición y la comisión los usen. Si lanza, o si
   * el FSM rechaza el evento, todo se deshace.
   */
  prepare?: (tx: TransactionalClient, locked: LockedPaymentRow) => Promise<Partial<LockedPaymentRow> | void>;
}

const QR_TTL_SECONDS = 5 * 60; // 5 min
const POS_QR_TTL_SECONDS = 30 * 60; // 30 min — camarero tiene tiempo de llegar
// Reducido de 30min → 2min. Razón: comprobado con Redsys que la "URL online"
// del panel BBVA suele estar desconfigurada o apuntando al integrador previo
// (tokenea, peanpe). Sin webhook, el cobro se atasca en AUTHORIZING aunque
// el banco lo procesara OK. Polling cada 2min vía adapter.getStatus cierra
// la ventana sin esperar 30min.
const ORPHAN_RECONCILE_DELAY_MS = 2 * 60 * 1000;

@Injectable()
export class PaymentsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly prisma: PrismaService;
  private readonly cls: ClsService<{ ctx: RequestContext }>;
  private readonly qrExpireQueue: Queue;
  private readonly orphanReconcileQueue: Queue;
  private readonly gateways: GatewayRegistry;
  private readonly realtime: RealtimeGateway;
  private readonly metrics: MetricsService;
  private readonly wallets: WalletsService;
  private readonly peanpe: PeanpeAdapter;
  private readonly redis: Redis;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(ClsService) cls: ClsService<{ ctx: RequestContext }>,
    @InjectQueue(QR_EXPIRE_QUEUE) qrExpireQueue: Queue,
    @InjectQueue(ORPHAN_RECONCILE_QUEUE) orphanReconcileQueue: Queue,
    @Inject(GatewayRegistry) gateways: GatewayRegistry,
    @Inject(RealtimeGateway) realtime: RealtimeGateway,
    @Inject(MetricsService) metrics: MetricsService,
    @Inject(WalletsService) wallets: WalletsService,
    @Inject(PeanpeAdapter) peanpe: PeanpeAdapter,
    @Inject(REDIS_CLIENT) redis: Redis,
  ) {
    this.prisma = prisma;
    this.cls = cls;
    this.qrExpireQueue = qrExpireQueue;
    this.orphanReconcileQueue = orphanReconcileQueue;
    this.gateways = gateways;
    this.realtime = realtime;
    this.metrics = metrics;
    this.wallets = wallets;
    this.peanpe = peanpe;
    this.redis = redis;
  }

  /**
   * Boot sweep: al arrancar la API, reencola un orphan-reconcile para cada
   * pago en AUTHORIZING ya antiguo (>=2 min) que tenga provider+providerTxId.
   * Sin esto, los pagos atascados de antes del deploy nunca se reconcilian
   * porque su BullMQ job repetable no fue creado o ya expiró.
   *
   * Single-replica: usa Redis SETNX para que solo una réplica corra el sweep
   * por deploy. Sin esto, en cluster con N réplicas haríamos N llamadas
   * paralelas a Redsys.restTrataPeticion por cada pago atascado.
   *
   * Idempotente extra: el `jobId: orphan-<paymentId>` lo deduplica con
   * cualquier job ya en cola.
   */
  async onApplicationBootstrap(): Promise<void> {
    // Lock distribuido — TTL 5 min cubre boot lento y previene zombie locks
    // si la réplica que tomó el lock crashea antes de liberar.
    const lockKey = 'boot-sweep:lock';
    const lockTtlSec = 300;
    const got = await this.redis.set(lockKey, '1', 'EX', lockTtlSec, 'NX');
    if (got !== 'OK') {
      this.logger.log('Boot sweep: otra réplica ya tiene el lock — skip');
      return;
    }

    try {
      const cutoff = new Date(Date.now() - 2 * 60 * 1000);
      const stuck = await this.prisma.$queryRawUnsafe<Array<{
        id: string;
        tenantId: string;
      }>>(
        `SELECT id::text, "tenantId"::text
         FROM payments
         WHERE status = 'AUTHORIZING'
           AND provider IS NOT NULL
           AND "providerTxId" IS NOT NULL
           AND "createdAt" < $1
         ORDER BY "createdAt" ASC
         LIMIT 100`,
        cutoff,
      );

      if (stuck.length === 0) {
        this.logger.log('Boot sweep: no AUTHORIZING payments to reconcile');
        return;
      }

      this.logger.log(`Boot sweep: re-queueing ${stuck.length} stuck AUTHORIZING payments`);
      for (const p of stuck) {
        await this.orphanReconcileQueue.add(
          'orphan-reconcile',
          { paymentId: p.id, tenantId: p.tenantId },
          {
            jobId: `orphan-${p.id}`,
            delay: 5000, // disparo inminente al boot
            attempts: 5,
            backoff: { type: 'exponential', delay: 30_000 },
            removeOnComplete: true,
            removeOnFail: 100,
          },
        );
      }
    } catch (err) {
      // ERROR, no warn — si el sweep falla los pagos quedan atascados.
      this.logger.error(`Boot sweep failed: ${(err as Error).message}`);
    }
  }

  /**
   * Construye la URL del formulario hosted Peanpe para el cliente.
   * Requiere que ya se haya llamado startAuthorization() y el adapter haya
   * persistido el peanpe_calls (con identificador_llamada y securityToken).
   */
  async getPeanpeRedirectUrl(qrToken: string): Promise<{ provider: string; url: string }> {
    const payment = await this.prisma.asSystem((tx) =>
      tx.payment.findUnique({
        where: { qrToken },
        include: { peanpeCall: true },
      }),
    );
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.provider !== 'PEANPE') {
      throw new ConflictException(`Payment provider is ${payment.provider}, not PEANPE`);
    }
    if (!payment.peanpeCall) {
      throw new ConflictException(
        'Peanpe call no inicializada — llama POST /start-authorization primero',
      );
    }
    const url = this.peanpe.buildPaymentUrl({
      identificadorLlamada: payment.peanpeCall.identificadorLlamada,
      amountCents: payment.amountCents,
      concepto: `${BRAND_NAME} ${payment.id.slice(0, 8)}`,
      debug: process.env.NODE_ENV !== 'production',
    });
    return { provider: 'PEANPE', url };
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

    // 2. Resolver terminal:
    //    - Si dto.terminalExternalId: lookup directo (backwards compat).
    //    - Si dto.zone (sin externalId): elegir cualquier terminal activo de
    //      esa zona. Si no hay → 400 con mensaje claro.
    //    - Si ambos: terminalExternalId gana.
    let terminal;
    if (dto.terminalExternalId) {
      terminal = await this.prisma.terminal.findUnique({
        where: {
          tenantId_externalId: { tenantId, externalId: dto.terminalExternalId },
        },
      });
      if (!terminal || !terminal.active) {
        throw new BadRequestException(
          `Terminal '${dto.terminalExternalId}' not found or inactive`,
        );
      }
    } else if (dto.zone) {
      // Normalizamos: si zone=OTRO, el canonical zone es 'OTRO/<zoneCustom>'.
      const canonicalZone =
        dto.zone === 'OTRO' && dto.zoneCustom
          ? `OTRO/${dto.zoneCustom.trim().toUpperCase()}`
          : dto.zone;
      terminal = await this.prisma.terminal.findFirst({
        where: { tenantId, zone: canonicalZone, active: true },
        // Terminal model no tiene timestamps; ordenamos por externalId estable.
        orderBy: { externalId: 'asc' },
      });
      if (!terminal) {
        throw new BadRequestException(
          `No hay PAX activos en zona '${canonicalZone}'. Revisa con el admin que haya terminales dados de alta y activos.`,
        );
      }
    } else {
      throw new BadRequestException(
        'Debes pasar terminalExternalId o zone para resolver el datáfono',
      );
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
    // Leemos el venue siempre (necesitamos platformCommissionBps para snapshot).
    const venue = await this.prisma.asSystem((tx) =>
      tx.venue.findUniqueOrThrow({
        where: { id: tenantId },
        select: {
          operatorMaxCobroCents: true,
          platformCommissionBps: true,
          operatorCommissionDefaults: true,
        },
      }),
    );
    // Fase 1A — cobro desde la carta: importe y categoría los fija el local
    // (los del cliente se ignoran). El tope de importe libre no aplica.
    let amountCents = dto.amountCents;
    let service: { serviceItemId: string; serviceName: string; durationMin: number | null } | null =
      null;
    let serviceCategory: RevenueCategory | undefined;
    if (dto.serviceItemId && !isWalletTopUp) {
      const item = await this.prisma.serviceItem.findFirst({
        where: { id: dto.serviceItemId, tenantId },
      });
      if (!item) {
        throw new NotFoundException('Ese servicio no está en la carta de este local');
      }
      const charge = applyServiceItem(item, creatorRole);
      if (!charge.ok) {
        throw new BadRequestException(SERVICE_ITEM_ERRORS[charge.reason]);
      }
      amountCents = charge.amountCents;
      serviceCategory = charge.revenueCategory;
      service = { serviceItemId: item.id, serviceName: charge.serviceName, durationMin: charge.durationMin };
    }

    if (creatorRole === 'OPERATOR' && !isWalletTopUp && !service) {
      if (amountCents > venue.operatorMaxCobroCents) {
        throw new BadRequestException(
          `Importe ${(amountCents / 100).toFixed(2)} € supera el límite del local (${(venue.operatorMaxCobroCents / 100).toFixed(2)} €). ` +
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

    // Tip handling: si hay tipCents, valida coherencia y resuelve política default.
    // Default: si creator es OPERATOR y no se especifica tipGoesTo → 'operator'.
    const tipCents = dto.tipCents ?? 0;
    let tipGoesTo: string | null = dto.tipGoesTo ?? null;
    let tipBeneficiaryUserId: string | null = dto.tipBeneficiaryUserId ?? null;
    if (tipCents > 0) {
      if (!tipGoesTo) {
        tipGoesTo = defaultTipGoesTo(creatorRole);
      }
      if (tipGoesTo === 'beneficiary' && !tipBeneficiaryUserId) {
        throw new BadRequestException(
          'tipGoesTo=beneficiary requiere tipBeneficiaryUserId',
        );
      }
      if (tipBeneficiaryUserId) {
        const beneficiary = await this.prisma.asSystem((tx) =>
          tx.user.findFirst({
            where: { id: tipBeneficiaryUserId!, tenantId, deletedAt: null },
            select: { id: true },
          }),
        );
        if (!beneficiary) {
          throw new BadRequestException('tipBeneficiaryUserId no pertenece al venue');
        }
      }
    } else {
      // Sin tip: limpiar campos para no persistir basura.
      tipGoesTo = null;
      tipBeneficiaryUserId = null;
    }

    const revenueCategory = resolveRevenueCategory({
      isWalletTopUp: Boolean(resolvedWalletId),
      creatorRole,
      requested: serviceCategory ?? (dto.revenueCategory as RevenueCategory | undefined),
    });
    if (!revenueCategory) {
      throw new BadRequestException(
        'Desde tu app solo puedes cobrar tus servicios. La barra, la habitación y la comida las cobra el camarero desde la caja.',
      );
    }

    const payment = await this.prisma.$transaction(async (tx) => {
      const p = await tx.payment.create({
        data: {
          tenantId,
          terminalId: terminal.id,
          createdByUserId: creatorUserId,
          idempotencyKey,
          amountCents,
          // availableAmountCents incluye tip — refunds pueden cubrir todo.
          availableAmountCents: amountCents + tipCents,
          currency: dto.currency,
          status: 'CREATED',
          qrToken,
          qrExpiresAt,
          // Snapshot del % plataforma al momento del cobro (contabilidad histórica
          // estable aunque el venue cambie el % mañana).
          platformCommissionBps: venue.platformCommissionBps,
          tipCents,
          revenueCategory,
          ...(tipGoesTo ? { tipGoesTo } : {}),
          ...(tipBeneficiaryUserId ? { tipBeneficiaryUserId } : {}),
          ...(effectiveCaptureMethod ? { captureMethod: effectiveCaptureMethod } : {}),
          ...(resolvedWalletId ? { walletId: resolvedWalletId } : {}),
          ...(service ?? {}),
        },
      });
      await tx.paymentEvent.create({
        data: {
          paymentId: p.id,
          tenantId,
          eventType: 'payment.created',
          payload: {
            amountCents: p.amountCents,
            tipCents,
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
        // H7: usar el TTL calculado para este payment (5min QR / 30min POS),
        // antes era siempre QR_TTL_SECONDS → POS expiraba a los 5min con el
        // camarero todavía en camino al datáfono.
        delay: ttlSeconds * 1000,
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );

    this.metrics.paymentsCreated.inc({ venue: tenantId, provider: 'pending' });
    this.logger.log(`Payment created ${payment.id} amount=${payment.amountCents} venue=${tenantId}`);
    return this.toCreatedResponse(payment.id);
  }

  /**
   * GET /pay/:token — lo que ve el cliente al escanear (o volver a escanear)
   * el QR. No abre nada en el banco: eso lo hace `startCheckout` cuando el
   * cliente pulsa un botón, así la vista previa de un enlace no abre pedidos.
   *  - 'choose'     → página de pago: importe, propina y botones.
   *  - 'paid'       → ya cobrado: "Pagado" (nunca se reenvía al banco).
   *  - 'closed'     → caducado / fallido / cancelado / sin confirmar.
   *  - 'processing' → hay un intento en curso: esperar al aviso del banco.
   */
  async getPayPage(qrToken: string): Promise<PayRedirect> {
    const payment = await this.findPayable(qrToken);
    const settled = settledPayView(payment);
    if (settled) return settled;
    if (payment.status !== 'AUTHORIZING') return choosePayPage(payment);
    // Otras pasarelas: se reenvía lo guardado, como antes.
    if (payment.provider !== 'REDSYS') return this.checkoutOf(payment.id);

    const attempts = await this.prisma.asSystem((tx) =>
      tx.paymentAttempt.findMany({
        where: { paymentId: payment.id },
        orderBy: { createdAt: 'desc' },
        select: { status: true, createdAt: true },
      }),
    );
    const decision = decideRedsysRetry({
      attempts,
      now: new Date(),
      qrExpiresAt: payment.qrExpiresAt,
      paymentUpdatedAt: payment.updatedAt,
    });
    // Denegado o abandonado: puede volver a elegir (p. ej. tarjeta en vez de Apple Pay).
    return decision === 'retry' ? choosePayPage(payment) : retryOutcome(decision);
  }

  /**
   * POST /pay/:token — el cliente eligió propina y botón. Abre un pedido en
   * el banco por importe + propina. En Redsys, si el intento anterior se
   * denegó o se abandonó, el pedido es NUEVO (reenviar el mismo Ds_Order da
   * SIS0051 "pedido repetido"); si hay uno recién abierto (doble toque), se
   * reutiliza. Devuelve 'checkout' → el controlador redirige al formulario.
   */
  async startCheckout(qrToken: string, choice: CheckoutChoice): Promise<PayRedirect> {
    const payment = await this.findPayable(qrToken);
    const settled = settledPayView(payment);
    if (settled) return settled;
    const tips = tipOptionsFor({ tipCents: payment.tipCents, allowTip: payment.allowTip });
    if (!tips.includes(choice.tipCents)) throw new BadRequestException('Propina no válida');

    if (payment.status !== 'AUTHORIZING') {
      let providerTxId: string | undefined;
      try {
        ({ providerTxId } = await this.startAuthorization(qrToken, choice));
      } catch (err) {
        // Doble toque: el otro POST ya abrió el pedido → mismo formulario.
        const order = await this.freshOrderOf(payment.id);
        if (!order) throw err;
        return { kind: 'checkout', order };
      }
      const view = await this.checkoutOf(payment.id);
      return view.kind === 'form' && providerTxId ? { kind: 'checkout', order: providerTxId } : view;
    }
    if (payment.provider !== 'REDSYS') return this.checkoutOf(payment.id);

    let outcome: { decision: RetryDecision | 'replay'; order: string | null; attempts: number };
    try {
      // Candado por cobro: decidir y abrir el intento nuevo es atómico, así
      // un doble toque no abre dos pedidos. El authorize de Redsys solo firma
      // el formulario (sin red).
      outcome = await this.prisma.asSystem(async (tx) => {
        await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtext(${payment.id}))`;
        const attempts = await tx.paymentAttempt.findMany({
          where: { paymentId: payment.id },
          orderBy: { createdAt: 'desc' },
          select: { providerTxId: true, status: true, createdAt: true },
        });
        const now = new Date();
        const fresh = freshPendingOrder(attempts, now);
        if (fresh) return { decision: 'replay' as const, order: fresh, attempts: attempts.length };
        const decision = decideRedsysRetry({
          attempts,
          now,
          qrExpiresAt: payment.qrExpiresAt,
          paymentUpdatedAt: payment.updatedAt,
        });
        if (decision !== 'retry') return { decision, order: null, attempts: attempts.length };
        const { providerTxId } = await this.authorizeAttempt(payment, 'REDSYS', tx, choice);
        return { decision, order: providerTxId, attempts: attempts.length };
      });
    } catch (err) {
      this.logger.error(`Reintento Redsys falló para ${payment.id}: ${(err as Error).message}`);
      throw new ConflictException(`Gateway error: ${((err as Error).message || '').slice(0, 300)}`);
    }
    if (outcome.order) {
      if (outcome.decision === 'retry') {
        this.logger.log(`Payment ${payment.id}: nuevo intento Redsys (${outcome.attempts + 1})`);
      }
      return { kind: 'checkout', order: outcome.order };
    }
    return retryOutcome(outcome.decision as Exclude<RetryDecision, 'retry'>);
  }

  /**
   * GET /pay/:token/checkout?op= — formulario hacia el banco del pedido
   * recién abierto. Solo mientras sea el último intento, siga pendiente y sea
   * reciente: si el cliente vuelve atrás desde el banco, `null` → vuelve a
   * la página del cobro (que decide esperar o dejar reintentar).
   */
  async getCheckoutForm(qrToken: string, order: string): Promise<PayRedirect | null> {
    const payment = await this.prisma.asSystem((tx) =>
      tx.payment.findUnique({
        where: { qrToken },
        select: { id: true, status: true, providerTxId: true },
      }),
    );
    if (!payment || payment.status !== 'AUTHORIZING' || payment.providerTxId !== order) return null;
    if ((await this.freshOrderOf(payment.id)) !== order) return null;
    const view = await this.checkoutOf(payment.id);
    return view.kind === 'form' ? view : null;
  }

  private async freshOrderOf(paymentId: string): Promise<string | null> {
    const attempts = await this.prisma.asSystem((tx) =>
      tx.paymentAttempt.findMany({
        where: { paymentId },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { providerTxId: true, status: true, createdAt: true },
      }),
    );
    return freshPendingOrder(attempts, new Date());
  }

  private async findPayable(
    qrToken: string,
  ): Promise<PayablePayment & { tenantId: string; provider: Provider | null; updatedAt: Date }> {
    const payment = await this.prisma.asSystem((tx) =>
      tx.payment.findUnique({
        where: { qrToken },
        select: {
          id: true,
          tenantId: true,
          status: true,
          provider: true,
          amountCents: true,
          tipCents: true,
          currency: true,
          qrExpiresAt: true,
          updatedAt: true,
          authorizedAt: true,
          walletId: true,
          wallet: { select: { qrToken: true } },
        },
      }),
    );
    if (!payment) throw new NotFoundException('Payment not found');
    // Pasarela que cobrará: la del cobro o, si aún no ha ido al banco, la
    // activa del local. La propina solo se cobra (y se reparte) con Redsys.
    const provider =
      payment.provider ??
      (
        await this.prisma.asSystem((tx) =>
          tx.gatewayCredential.findFirst({
            where: { tenantId: payment.tenantId, active: true },
            orderBy: { createdAt: 'asc' },
            select: { provider: true },
          }),
        )
      )?.provider ??
      null;
    const { walletId, wallet, ...rest } = payment;
    return {
      ...rest,
      status: payment.status as PaymentMachineState,
      allowTip: provider === 'REDSYS' && walletId === null,
      walletToken: wallet?.qrToken ?? null,
    };
  }

  /**
   * Para la página /pay/result a la que vuelve el cliente desde el banco:
   * estado REAL del pago a partir del pedido de la pasarela (Ds_Order).
   */
  async getResultView(providerTxId: string): Promise<PayResultView | null> {
    if (!providerTxId) return null;
    return this.prisma.asSystem(async (tx) => {
      const attempt = await tx.paymentAttempt.findFirst({
        where: { providerTxId },
        select: { paymentId: true },
      });
      const payment = await tx.payment.findFirst({
        where: attempt ? { id: attempt.paymentId } : { providerTxId },
        select: {
          id: true,
          status: true,
          amountCents: true,
          tipCents: true,
          currency: true,
          authorizedAt: true,
          qrToken: true,
          wallet: { select: { qrToken: true } },
        },
      });
      if (!payment) return null;
      const thisAttempt = await tx.paymentAttempt.findFirst({
        where: { paymentId: payment.id, providerTxId },
        select: { status: true },
      });
      return {
        paymentId: payment.id,
        status: payment.status as PaymentMachineState,
        amountCents: payment.amountCents,
        tipCents: payment.tipCents,
        currency: payment.currency,
        authorizedAt: payment.authorizedAt,
        qrToken: payment.qrToken,
        walletToken: payment.wallet?.qrToken ?? null,
        attemptStatus: thisAttempt?.status ?? null,
      };
    });
  }

  /** Justificante del cliente (solo cobros pagados). Sin datos personales. */
  async getReceipt(qrToken: string): Promise<PayReceiptView | null> {
    return this.prisma.asSystem(async (tx) => {
      const payment = await tx.payment.findUnique({
        where: { qrToken },
        select: {
          id: true,
          status: true,
          amountCents: true,
          tipCents: true,
          currency: true,
          authorizedAt: true,
          authCode: true,
          cardBrand: true,
          providerTxId: true,
        },
      });
      if (!payment || !PAID_STATES.has(payment.status as PaymentMachineState)) return null;
      const charged = await tx.paymentAttempt.findFirst({
        where: { paymentId: payment.id, status: 'APPROVED' },
        orderBy: { createdAt: 'asc' },
        select: { providerTxId: true, payMethod: true },
      });
      const method = charged?.payMethod;
      return {
        paymentId: payment.id,
        amountCents: payment.amountCents,
        tipCents: payment.tipCents,
        currency: payment.currency,
        authorizedAt: payment.authorizedAt,
        authCode: payment.authCode,
        cardBrand: payment.cardBrand,
        payMethod: method === 'wallet' || method === 'card' ? (method as PayMethodChoice) : null,
        order: charged?.providerTxId ?? payment.providerTxId,
      };
    });
  }

  private async checkoutOf(paymentId: string): Promise<PayRedirect> {
    const refreshed = await this.prisma.asSystem((tx) =>
      tx.payment.findUnique({
        where: { id: paymentId },
        select: { status: true, gatewayPaymentUrl: true, gatewayCheckoutForm: true },
      }),
    );
    const status = refreshed?.status as PaymentMachineState;
    if (refreshed?.gatewayCheckoutForm) {
      const form = refreshed.gatewayCheckoutForm as {
        action: string;
        method: 'POST';
        fields: Record<string, string>;
      };
      return { kind: 'form', action: form.action, method: 'POST', fields: form.fields, status };
    }
    if (refreshed?.gatewayPaymentUrl) {
      return { kind: 'redirect', url: refreshed.gatewayPaymentUrl, status };
    }
    throw new ConflictException(`Payment en estado ${status} — no se puede redirigir al checkout`);
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
   *
   * @param expectedTenantId Si se pasa, valida que el payment pertenece a este
   *   tenant. Defensa cross-tenant: el caller idealmente debería pasar el
   *   tenantId que tiene en su contexto. Sin él, la función sigue funcionando
   *   por UUID directo (compat con workers de webhook donde el tenantId se
   *   resuelve después del lookup).
   */
  async transition(
    paymentId: string,
    event: PaymentEvent,
    expectedTenantId?: string,
    opts?: TransitionOptions,
  ): Promise<void> {
    // transition() es interna (workers + refunds futuros). Usamos SQL crudo end-to-end
    // para evitar interaccion ambigua con el middleware de tenant: el lock pesimista
    // y el UPDATE deben ir sobre la MISMA fila. Cualquier filtro adicional del
    // middleware podria desincronizar la lectura del lock con la escritura.
    let nextState: PaymentMachineState | undefined;
    let prevState: PaymentMachineState | undefined;
    let amountCents = 0;
    let tipCents = 0;

    await this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<LockedPaymentRow[]>`
          SELECT id, "tenantId", status, "amountCents", "availableAmountCents",
                 "providerTxId", provider, "createdByUserId", "walletId",
                 "tipCents", "tipGoesTo", "tipBeneficiaryUserId",
                 "revenueCategory"
            FROM payments
           WHERE id = ${paymentId}::uuid
           FOR UPDATE
        `;

        const locked = rows[0];
        if (!locked) throw new NotFoundException(`Payment ${paymentId} not found`);

        // Defensa cross-tenant: si el caller pasó tenantId, verificar coincidencia.
        // Usamos NotFoundException (no Forbidden) para no filtrar existencia del pago.
        if (expectedTenantId && locked.tenantId !== expectedTenantId) {
          this.logger.warn(
            `transition tenant mismatch payment=${paymentId} expected=${expectedTenantId} actual=${locked.tenantId}`,
          );
          throw new NotFoundException(`Payment ${paymentId} not found`);
        }

        // Fase 1B: la propina que cobró el banco es la del intento aprobado
        // (event.providerTxId). Se fija aquí, en la misma transacción que
        // reparte la comisión, venga del aviso, de la conciliación o del
        // panel. Si el FSM rechaza el evento, el rollback la deshace.
        // Datos que el llamador guarda en la MISMA transacción que la
        // transición (p. ej. el datáfono: operación, tarjeta y propina). Si el
        // FSM rechaza el evento, el rollback los deshace.
        const prepared = opts?.prepare ? await opts.prepare(tx, locked) : undefined;
        const base: LockedPaymentRow = prepared ? { ...locked, ...prepared } : locked;
        const p = event.type === 'AUTHORIZED' ? await this.withChargedTip(tx, base, event) : base;

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
                 provider = ${(result.nextContext.provider ?? p.provider) as 'WIPAY' | 'PEANPE' | 'PAYTEF' | 'REDSYS' | null}::"Provider",
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
        // Nota: el tip va SEPARADO del balance — propinas no son saldo gastable
        // por el cliente, se asignan al beneficiario directamente.
        if (result.nextState === 'AUTHORIZED' && p.walletId) {
          // H3: filtro tenantId en SELECT FOR UPDATE (no solo defensa post-lock
          // sino que el lock se adquiere sobre la fila correcta del tenant).
          const walletLocked = await tx.$queryRaw<
            Array<{ id: string; balanceCents: number; status: string }>
          >`
            SELECT id, "balanceCents", status FROM client_wallets
             WHERE id = ${p.walletId}::uuid
               AND "tenantId" = ${p.tenantId}::uuid
             FOR UPDATE
          `;
          const w = walletLocked[0];
          if (w && w.status === 'ACTIVE') {
            await tx.$executeRaw`
              UPDATE client_wallets
                 SET "balanceCents" = "balanceCents" + ${p.amountCents}::int,
                     "updatedAt" = now()
               WHERE id = ${p.walletId}::uuid
                 AND "tenantId" = ${p.tenantId}::uuid
            `;
            this.logger.log(
              `Payment ${paymentId} AUTHORIZED → wallet ${p.walletId} credited +${p.amountCents}c (new balance: ${w.balanceCents + p.amountCents})`,
            );
          } else {
            // C4: NO se acredita el wallet pero el cliente YA pagó al PSP.
            // Discrepancia financiera. NO podemos throw aquí (rollback ⇒ webhook
            // retry infinito), pero emitimos 3 canales de alerta:
            //   1. Métrica Prometheus (alerta a >0)
            //   2. Audit log con action específico searchable
            //   3. Log ERROR (no WARN — esto es crítico)
            const walletStatus = w?.status ?? 'missing';
            this.metrics.walletCreditSkipped.inc({
              venue: p.tenantId,
              wallet_status: walletStatus,
            });
            this.logger.error(
              `CRITICAL: Payment ${paymentId} AUTHORIZED but wallet ${p.walletId} not creditable (status=${walletStatus}, amount=${p.amountCents}c). Customer charged. Manual review + refund or wallet revive required.`,
            );
            // Audit dentro de tx — si el commit falla, el log también.
            await tx.$executeRaw`
              INSERT INTO audit_events ("tenantId", action, "targetType", "targetId", payload, "occurredAt")
              VALUES (${p.tenantId}::uuid, 'wallet.credit_skipped_critical',
                      'Payment', ${paymentId},
                      ${JSON.stringify({
                        walletId: p.walletId,
                        walletStatus,
                        amountCents: p.amountCents,
                        reason: 'wallet_not_active_at_authorized',
                      })}::jsonb,
                      now())
            `;
          }
        }

        // Snapshot del creator role + comisiones del venue. Usado por:
        //   1) Earning del creator si role=OPERATOR (CHICA_SERVICE → 90%, VENUE_* → 0% por defecto)
        //   2) Tip-only earning a beneficiary si creator NO es OPERATOR
        let creatorRole: string | null = null;
        let creatorCommissionBps: number | null = null;
        // Map de comisiones por categoría del venue (operatorCommissionDefaults).
        // Lo cargamos aquí para que la resolución de bps por categoría sea pura.
        let venueCommissionMap: Record<string, number> = {
          CHICA_SERVICE: 9000,
          VENUE_BAR: 0,
          VENUE_ROOM: 0,
          VENUE_FOOD: 0,
          EXTRA: 0,
        };
        if (result.nextState === 'AUTHORIZED' && p.createdByUserId) {
          const creatorRows = await tx.$queryRaw<
            Array<{ role: string; commissionBps: number | null }>
          >`
            SELECT role::text AS role, "commissionBps"
              FROM users
             WHERE id = ${p.createdByUserId}::uuid
          `;
          if (creatorRows[0]) {
            creatorRole = creatorRows[0].role;
            creatorCommissionBps = creatorRows[0].commissionBps;
          }
          const venueRows = await tx.$queryRaw<
            Array<{ operatorCommissionDefaults: Record<string, number> | null }>
          >`
            SELECT "operatorCommissionDefaults"
              FROM venues
             WHERE id = ${p.tenantId}::uuid
          `;
          if (venueRows[0]?.operatorCommissionDefaults) {
            venueCommissionMap = {
              ...venueCommissionMap,
              ...venueRows[0].operatorCommissionDefaults,
            };
          }
        }

        // Hook de earning para OPERATOR — si transitamos a AUTHORIZED y el creador
        // del payment es una operadora, snapshot de comisión en operator_earnings.
        // Math.round (no floor) evita bias unidireccional contra la operadora —
        // el céntimo perdido por redondeo se reparte 50/50 estadísticamente.
        // Idempotente: la unique en paymentId rechaza un segundo insert (defensa
        // contra una transición duplicada que la FSM ya filtra).
        // NOTA: si p.walletId está set, NO generamos earning aquí — el earning
        // se genera per-consumption en wallets.service (chica cobra granular).
        if (result.nextState === 'AUTHORIZED' && p.createdByUserId && !p.walletId) {
          const bpsForOperator = resolveBpsForOperator({
            category: p.revenueCategory,
            userCommissionBpsOverride: creatorCommissionBps,
            venueMap: venueCommissionMap as Partial<OperatorCommissionDefaults>,
          });
          // Solo creamos earning si:
          //   - creator es OPERATOR
          //   - bps resolvidos > 0 (en VENUE_* con default 0 no hay earning)
          if (creatorRole === 'OPERATOR') {
            const creator = { id: p.createdByUserId };
            const bps = bpsForOperator;
            const commissionCents = Math.round((p.amountCents * bps) / 10_000);

            // Tip: si la propina va a la chica creator (o a beneficiary explícito
            // que coincide con ella), 100% se suma al earning. Si va a venue/shared
            // o a otro beneficiario, el earning lleva solo la comisión.
            let earningTipCents = 0;
            if (p.tipCents > 0) {
              const goes = p.tipGoesTo ?? 'operator';
              if (goes === 'operator') {
                earningTipCents = p.tipCents;
              } else if (goes === 'beneficiary' && p.tipBeneficiaryUserId === creator.id) {
                earningTipCents = p.tipCents;
              }
            }

            // Sin comisión pero con propina para ella: la propina también le llega.
            if (bps > 0 || earningTipCents > 0) {
              await tx.$executeRaw`
                INSERT INTO operator_earnings (
                  "tenantId", "operatorId", "paymentId",
                  "paymentAmountCents", "commissionBps", "commissionCents", "tipCents"
                )
                VALUES (
                  ${p.tenantId}::uuid,
                  ${creator.id}::uuid,
                  ${paymentId}::uuid,
                  ${p.amountCents}::int,
                  ${bps}::int,
                  ${commissionCents}::int,
                  ${earningTipCents}::int
                )
                ON CONFLICT ("paymentId") DO NOTHING
              `;
            }
          }
        }

        // Si tip va a un beneficiary específico que NO es el creator OPERATOR,
        // y ese beneficiary es OPERATOR del venue, crear un earning aparte
        // (consumptionId/paymentId ambos null no son válidos en el schema actual;
        // por simplicidad, los tips a no-creator se ligan al mismo paymentId pero
        // como una "tip-only" earning row con commissionCents=0 y tipCents>0).
        // NOTA: por unique(paymentId), si ya hay earning para el creator, este
        // segundo insert falla. Por eso, este flujo solo aplica cuando creator NO
        // es OPERATOR (createdByUserId null o role!=OPERATOR) y hay un beneficiary
        // OPERATOR distinto. Caso típico: OWNER crea cobro POS para mesa atendida
        // por chica X — tip va a X via tipBeneficiaryUserId.
        if (
          result.nextState === 'AUTHORIZED' &&
          p.tipCents > 0 &&
          p.tipGoesTo === 'beneficiary' &&
          p.tipBeneficiaryUserId &&
          !p.walletId
        ) {
          const benefRows = await tx.$queryRaw<
            Array<{ id: string; role: string; commissionBps: number | null }>
          >`
            SELECT id, role::text AS role, "commissionBps"
              FROM users
             WHERE id = ${p.tipBeneficiaryUserId}::uuid
          `;
          const benef = benefRows[0];
          // C5 FIX: el guard previo usaba `createdByUserId !== null` (siempre true
          // si OWNER/MANAGER crea el cobro → beneficiary nunca recibía tip).
          // Ahora usamos el role real del creator: si NO es OPERATOR, no hay earning
          // del creator y podemos crear el tip-only earning del beneficiary sin
          // colisionar con la unique(paymentId).
          const creatorIsOperator = creatorRole === 'OPERATOR';
          if (
            benef?.role === 'OPERATOR' &&
            benef.id !== p.createdByUserId &&
            !creatorIsOperator
          ) {
            await tx.$executeRaw`
              INSERT INTO operator_earnings (
                "tenantId", "operatorId", "paymentId",
                "paymentAmountCents", "commissionBps", "commissionCents", "tipCents"
              )
              VALUES (
                ${p.tenantId}::uuid,
                ${benef.id}::uuid,
                ${paymentId}::uuid,
                ${p.amountCents}::int,
                0::int,
                0::int,
                ${p.tipCents}::int
              )
              ON CONFLICT ("paymentId") DO NOTHING
            `;
            this.logger.log(
              `Payment ${paymentId} AUTHORIZED → tip-only earning created for beneficiary=${benef.id} amount=${p.tipCents}c`,
            );
          }
        }

        prevState = p.status;
        nextState = result.nextState;
        amountCents = p.amountCents;
        tipCents = p.tipCents;
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
        this.realtime.emitPaymentCompleted(paymentId, nextState, tipCents);
      }
    }
  }

  /**
   * Fija en el cobro la propina del intento que cobró el banco. Devuelve una
   * copia de la fila con la propina y el importe devolvible ya ajustados.
   */
  private async withChargedTip<
    T extends { id: string; amountCents: number; tipGoesTo: string | null },
  >(tx: TransactionalClient, p: T, event: { provider: string; providerTxId: string }): Promise<T> {
    const charged = await readChargedTip(tx, p.id, event);
    if (!charged) return p;
    const settled = settleChargedTip({
      amountCents: p.amountCents,
      tipCents: charged.tipCents,
      tipGoesTo: p.tipGoesTo,
      creatorRole: charged.creatorRole,
    });
    await tx.$executeRaw`
      UPDATE payments
         SET "tipCents" = ${settled.tipCents}::int,
             "availableAmountCents" = ${settled.availableAmountCents}::int,
             "tipGoesTo" = ${settled.tipGoesTo}
       WHERE id = ${p.id}::uuid
    `;
    return { ...p, ...settled };
  }

  /**
   * Cancela un pago en estado CREATED|AWAITING_CAPTURE.
   * - OPERATOR solo puede cancelar payments creados por ella.
   * - OWNER/MANAGER pueden cancelar cualquier payment del venue.
   * Returns 409 si el FSM no permite (estado terminal).
   */
  async cancel(
    paymentId: string,
    actor: { userId: string; role: string; tenantId: string },
  ): Promise<{ status: PaymentMachineState }> {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Payment not found');

    if (actor.role === 'OPERATOR' && payment.createdByUserId !== actor.userId) {
      throw new ForbiddenException('No puedes cancelar cobros de otra operadora');
    }

    try {
      // H2: pasamos expectedTenantId — transition() valida que payment.tenantId
      // coincide con el del actor, defensa cross-tenant aunque la query previa
      // ya filtra por CLS middleware.
      await this.transition(
        paymentId,
        { type: 'CANCELED', reason: 'user-canceled' },
        actor.tenantId,
      );
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
    actor: { userId: string; role: string; tenantId: string },
    dto: { posReceiptRef: string; posReceiptPhoto?: string; notes?: string },
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

    // El código de autorización identifica UNA operación del datáfono: si ya
    // confirmó otro cobro del mismo terminal en las últimas 24 h, es un ticket
    // reutilizado (o un error de tecleo) y no se acepta.
    const authCode = dto.posReceiptRef.replace(/\s+/g, '').toUpperCase();
    const reused = await this.prisma.payment.findFirst({
      where: {
        id: { not: paymentId },
        terminalId: payment.terminalId,
        authCode,
        authorizedAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) },
      },
      select: { id: true },
    });
    if (reused) {
      throw new ConflictException(
        'Ese código de autorización ya se usó en otro cobro de este datáfono. Revisa el ticket.',
      );
    }

    try {
      // H2: expectedTenantId para defensa cross-tenant en confirmPosPayment.
      await this.transition(
        paymentId,
        { type: 'POS_CONFIRMED', posReceiptRef: authCode },
        actor.tenantId,
      );
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        throw new ConflictException(
          `Payment cannot be confirmed in state ${payment.status}`,
        );
      }
      throw err;
    }

    await this.prisma.payment.update({
      where: { id: paymentId },
      data: { authCode, authorizedAt: new Date() },
    });

    // Audit log con la prueba de cobro (ref + foto opcional). Si hay disputa
    // o auditoría AEAT, este registro es lo que demuestra que la chica
    // efectivamente cobró en el datáfono (no se inventó el AUTHORIZED).
    await this.prisma.paymentEvent.create({
      data: {
        paymentId,
        tenantId: actor.tenantId,
        eventType: 'pos.confirmed',
        payload: {
          posReceiptRef: dto.posReceiptRef,
          // La foto puede ser pesada — la guardamos en payload (JSONB Postgres
          // comprime). Para volumen alto, migrar a S3/R2 en futuro.
          hasPhoto: !!dto.posReceiptPhoto,
          ...(dto.posReceiptPhoto ? { posReceiptPhoto: dto.posReceiptPhoto } : {}),
          notes: dto.notes ?? null,
          confirmedByUserId: actor.userId,
          confirmedByRole: actor.role,
        },
        traceId: this.cls.get('ctx')?.traceId ?? randomUUID(),
      },
    });

    this.logger.log(
      `Payment ${paymentId} POS_CONFIRMED by ${actor.role}=${actor.userId} ref=${dto.posReceiptRef} photo=${!!dto.posReceiptPhoto}`,
    );

    return { status: 'AUTHORIZED' };
  }

  /**
   * Lista cobros POS pendientes (status=CREATED + captureMethod=POS_EXTERNAL)
   * para el panel del camarero. Tenant-scoped vía CLS.
   */
  async listPendingPos(tenantId: string, zone?: string) {
    const rows = await this.prisma.payment.findMany({
      where: {
        tenantId,
        status: 'CREATED',
        captureMethod: 'POS_EXTERNAL',
        // Filtro opcional por zona — pasa por la relación terminal.
        ...(zone ? { terminal: { zone } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        createdBy: { select: { displayName: true, email: true } },
        terminal: { select: { zone: true, label: true } },
      },
    });
    return rows.map((p) => ({
      id: p.id,
      amountCents: p.amountCents,
      currency: p.currency,
      createdAt: p.createdAt.toISOString(),
      qrExpiresAt: p.qrExpiresAt.toISOString(),
      createdByName: p.createdBy?.displayName ?? p.createdBy?.email ?? '—',
      zone: p.terminal?.zone ?? null,
      terminalLabel: p.terminal?.label ?? null,
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
    choice?: CheckoutChoice,
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

    // 3) Llamar a la pasarela (timeouts y circuit breaker en el adapter) y
    //    4) persistir providerTxId + URL/form + intento (payment_attempts).
    let providerTxId: string;
    try {
      ({ providerTxId } = await this.authorizeAttempt(payment, credential.provider, undefined, choice));
    } catch (err) {
      const errMsg = (err as Error).message || 'unknown';
      this.logger.error(`Gateway authorize failed for ${payment.id}: ${errMsg}`);
      // Saga: si la pasarela rechaza inmediatamente, marcar FAILED.
      try {
        await this.transition(payment.id, { type: 'FAILED', reason: 'gateway-authorize-error' });
      } catch (e2) {
        if (!(e2 instanceof InvalidTransitionError)) throw e2;
      }
      // Propagar mensaje real durante bring-up (sin tener acceso a logs Dokploy).
      throw new ConflictException(`Gateway error: ${errMsg.slice(0, 300)}`);
    }

    // 5) Encolar orphan-reconcile (se autocancela si llega webhook antes)
    // Attempts + backoff: si la pasarela devuelve UNKNOWN reintenta 5 veces.
    // Tras agotar, el processor transiciona el pago a ORPHAN (visible en
    // admin para reconciliación manual).
    await this.orphanReconcileQueue.add(
      'orphan-reconcile',
      { paymentId: payment.id, tenantId: payment.tenantId },
      {
        jobId: `orphan-${payment.id}`,
        delay: ORPHAN_RECONCILE_DELAY_MS,
        attempts: 5,
        backoff: { type: 'exponential', delay: 30_000 },
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
   * Abre un intento en la pasarela: authorize() + guarda providerTxId,
   * URL/form del checkout y la fila de payment_attempts. Cada intento es un
   * pedido distinto, y el aviso del banco se resuelve por cualquiera de ellos.
   *
   * Al banco va importe + propina: la que eligió el cliente en la página de
   * pago o, sin página (endpoint antiguo), la que ya tuviera el cobro.
   */
  private async authorizeAttempt(
    payment: { id: string; tenantId: string; amountCents: number; tipCents: number; currency: string },
    provider: Provider,
    inTx?: TransactionalClient,
    choice?: CheckoutChoice,
  ): Promise<{ providerTxId: string }> {
    const adapter = this.gateways.get(provider);
    // Solo Redsys cobra y reparte la propina (la del aprobado pasa al cobro
    // en transition). Las demás pasarelas cobran el importe, como antes.
    const tipCents = provider === 'REDSYS' ? (choice?.tipCents ?? payment.tipCents) : null;
    const chargeCents = payment.amountCents + (tipCents ?? 0);
    const result = await adapter.authorize({
      tenantId: payment.tenantId,
      paymentId: payment.id,
      amountCents: chargeCents,
      currency: payment.currency,
      terminalExternalId: '',
      reference: payment.id,
      ...(provider === 'REDSYS' && choice?.method ? { payMethod: choice.method } : {}),
      ...(choice ? { language: choice.language } : {}),
    });
    const paymentLinkUrl = result.paymentLinkUrl ?? null;
    const checkoutForm = result.checkoutForm ?? null;
    const persist = async (tx: TransactionalClient): Promise<void> => {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          providerTxId: result.providerTxId,
          ...(paymentLinkUrl ? { gatewayPaymentUrl: paymentLinkUrl } : {}),
          ...(checkoutForm ? { gatewayCheckoutForm: checkoutForm } : {}),
        },
      });
      await tx.paymentAttempt.create({
        data: {
          paymentId: payment.id,
          tenantId: payment.tenantId,
          provider,
          providerTxId: result.providerTxId,
          amountCents: chargeCents,
          tipCents,
          payMethod: choice?.method ?? null,
        },
      });
    };
    if (inTx) await persist(inTx);
    else await this.prisma.asSystem(persist);
    return { providerTxId: result.providerTxId };
  }

  /**
   * Reverse proporcional de la comisión cuando hay refund (parcial o total).
   * Llamado por RefundsService después de que el refund llega a SUCCEEDED.
   *
   * Idempotencia: tabla earning_reversals(refundId UNIQUE). Si el processor
   * reintenta con el mismo refundId, no duplicamos el descuento.
   *
   * Accumulator pattern: en lugar de sumar `floor(refundN * bps / 10000)` por
   * cada refund (que acumula dust), calculamos el reversedTotal ESPERADO en
   * función del cumulativo refundeado hasta el momento, y aplicamos el delta:
   *
   *   expectedTotalReversed = round(totalCumulativeRefunded * bps / 10000)
   *   delta = expectedTotalReversed - currentReversedCents
   *
   * Esto garantiza el invariante: si todos los refunds suman amountCents, el
   * reversedCents acumulado iguala exactamente commissionCents — sin dust.
   *
   * Permite saldo negativo (deuda) si reversedCents > commissionCents (no debería
   * pasar con accumulator, pero por defensa lo permitimos).
   */
  async applyRefundToEarning(
    paymentId: string,
    refundId: string,
    refundAmountCents: number,
  ): Promise<void> {
    if (refundAmountCents <= 0) return;
    await this.prisma.$transaction(async (tx) => {
      // 0. Idempotency check: si ya aplicamos este refund, no-op.
      const already = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM earning_reversals WHERE "refundId" = ${refundId}::uuid
      `;
      if (already.length > 0) {
        this.logger.log(
          `Earning reversal already applied for refund=${refundId} payment=${paymentId} — skip`,
        );
        return;
      }

      // 1. Lock earning + leer estado actual.
      const earning = await tx.$queryRaw<
        Array<{
          id: string;
          tenantId: string;
          commissionBps: number;
          commissionCents: number;
          reversedCents: number;
          paymentAmountCents: number;
          payoutId: string | null;
        }>
      >`
        SELECT id, "tenantId", "commissionBps", "commissionCents", "reversedCents",
               "paymentAmountCents", "payoutId"
          FROM operator_earnings
         WHERE "paymentId" = ${paymentId}::uuid
         FOR UPDATE
      `;
      if (earning.length === 0) {
        this.logger.log(
          `applyRefundToEarning: no earning for payment=${paymentId} (creator not OPERATOR)`,
        );
        return;
      }
      const e = earning[0]!;

      // 2. Total cumulativo refundeado: suma de refunds SUCCEEDED para este payment
      //    (incluye el actual aunque su status todavía no esté commiteado).
      const sumRows = await tx.$queryRaw<Array<{ total: bigint }>>`
        SELECT COALESCE(SUM("amountCents"),0)::bigint AS total
          FROM refunds
         WHERE "paymentId" = ${paymentId}::uuid
           AND status = 'SUCCEEDED'
           AND id != ${refundId}::uuid
      `;
      const priorCumulative = Number(sumRows[0]?.total ?? 0);
      const totalCumulative = Math.min(
        priorCumulative + refundAmountCents,
        e.paymentAmountCents, // cap por seguridad
      );

      // 3. Reversed total esperado tras este refund. Las reversiones que llegan
      //    con el earning ya pagado no tocan reversedCents (eso refleja lo que
      //    se le pagó); se suman aparte como deuda.
      const expectedTotalReversed = Math.round(
        (totalCumulative * e.commissionBps) / 10_000,
      );
      const debtRows = await tx.$queryRaw<Array<{ total: bigint }>>`
        SELECT COALESCE(SUM("reversedDeltaCents"),0)::bigint AS total
          FROM earning_reversals
         WHERE "earningId" = ${e.id}::uuid
           AND "afterPayout"
      `;
      const alreadyReversed = e.reversedCents + Number(debtRows[0]?.total ?? 0);
      const reverseDelta = expectedTotalReversed - alreadyReversed;
      const afterPayout = e.payoutId !== null;

      if (reverseDelta <= 0) {
        this.logger.warn(
          `Earning reversal delta non-positive payment=${paymentId} refundId=${refundId} expected=${expectedTotalReversed} current=${alreadyReversed} — skip update`,
        );
      } else if (afterPayout) {
        // Ya pagado a la chica: queda como deuda (earning_reversals.afterPayout)
        // y createPayout la descuenta del siguiente pago.
        this.logger.warn(
          `Refund after payout payment=${paymentId} refundId=${refundId}: deuda de ${reverseDelta}c para el siguiente pago`,
        );
      } else {
        await tx.$executeRaw`
          UPDATE operator_earnings
             SET "reversedCents" = "reversedCents" + ${reverseDelta}::int
           WHERE id = ${e.id}::uuid
        `;
      }

      // 4. Registrar reversal para idempotencia (siempre, incluso si delta=0).
      await tx.$executeRaw`
        INSERT INTO earning_reversals (
          "tenantId", "earningId", "refundId", "reversedDeltaCents", "afterPayout"
        )
        VALUES (
          ${e.tenantId}::uuid,
          ${e.id}::uuid,
          ${refundId}::uuid,
          ${Math.max(0, reverseDelta)}::int,
          ${afterPayout && reverseDelta > 0}
        )
        ON CONFLICT ("refundId") DO NOTHING
      `;

      this.logger.log(
        `Earning reversal payment=${paymentId} refundId=${refundId} delta=${reverseDelta} expected=${expectedTotalReversed} bps=${e.commissionBps} cumulative=${totalCumulative}/${e.paymentAmountCents}`,
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
      include: { wallet: { select: { id: true } } },
    });
    // Helper para tratar string vacío y whitespace como "no configurado".
    // process.env.X devuelve undefined si no existe, pero "" si Dokploy
    // tiene la variable definida sin valor → ?? no la captura.
    const nonEmpty = (v: string | undefined): string | undefined =>
      v && v.trim().length > 0 ? v.trim().replace(/\/+$/, '') : undefined;
    const ensureProto = (u: string): string =>
      /^https?:\/\//i.test(u) ? u : `https://${u}`;
    const baseUrl = ensureProto(
      nonEmpty(process.env.NEXT_PUBLIC_API_URL) ??
        `http://localhost:${process.env.PORT ?? 4100}`,
    );
    // Preferimos web-client si está configurado (UX nicer); si no, el API
    // mismo expone /pay/{token} con redirect 302 al checkout del PSP.
    const clientUrl = ensureProto(
      nonEmpty(process.env.NEXT_PUBLIC_WEB_CLIENT_URL) ?? baseUrl,
    );
    // Operator app URL — para QR de POS_EXTERNAL (camarero escanea, abre app
    // del operator pre-focused en el cobro a confirmar). Si NEXT_PUBLIC_OPERATOR_URL
    // no está, derivamos cambiando api. → operator. en el baseUrl.
    const operatorUrl = ensureProto(
      nonEmpty(process.env.NEXT_PUBLIC_OPERATOR_URL) ??
        baseUrl.replace(/^https?:\/\/api\./i, 'https://operator.'),
    );
    // Para POS_EXTERNAL: el QR NO debe llevar a Paytef (eso cobraría dos veces).
    // En su lugar, encodea URL del operator app que abre el cobro para que el
    // camarero lo confirme tras pasar la tarjeta por su datáfono físico.
    const qrUrl =
      p.captureMethod === 'POS_EXTERNAL'
        ? `${operatorUrl}/?pos=${p.id}`
        : `${clientUrl}/pay/${p.qrToken}`;
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
      // Recarga de saldo: el id de la wallet. Su enlace (la credencial del
      // cliente para aceptar cobros) no se da nunca al personal.
      walletId: p.walletId ?? null,
    };
  }
}
