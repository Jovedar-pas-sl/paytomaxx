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
import { PeanpeAdapter } from '../gateways/peanpe.adapter';
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
  private readonly peanpe: PeanpeAdapter;

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
      concepto: `NightPay ${payment.id.slice(0, 8)}`,
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
    if (creatorRole === 'OPERATOR' && !isWalletTopUp) {
      if (dto.amountCents > venue.operatorMaxCobroCents) {
        throw new BadRequestException(
          `Importe ${(dto.amountCents / 100).toFixed(2)} € supera el límite del local (${(venue.operatorMaxCobroCents / 100).toFixed(2)} €). ` +
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
        tipGoesTo = creatorRole === 'OPERATOR' ? 'operator' : 'venue';
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

    // revenueCategory: si viene del DTO úsalo; si no, infer por rol/contexto.
    //   - WALLET_TOPUP: siempre EXTRA (la categoría real se asigna por consumption)
    //   - creator OPERATOR + sin wallet → CHICA_SERVICE
    //   - cualquier otro → EXTRA (el camarero/admin debe elegir explícito)
    const revenueCategory: string =
      dto.revenueCategory ??
      (resolvedWalletId
        ? 'EXTRA'
        : creatorRole === 'OPERATOR'
          ? 'CHICA_SERVICE'
          : 'EXTRA');

    const payment = await this.prisma.$transaction(async (tx) => {
      const p = await tx.payment.create({
        data: {
          tenantId,
          terminalId: terminal.id,
          createdByUserId: creatorUserId,
          idempotencyKey,
          amountCents: dto.amountCents,
          // availableAmountCents incluye tip — refunds pueden cubrir todo.
          availableAmountCents: dto.amountCents + tipCents,
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
  ): Promise<void> {
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
            provider: 'WIPAY' | 'PEANPE' | 'PAYTEF' | null;
            createdByUserId: string | null;
            walletId: string | null;
            tipCents: number;
            tipGoesTo: string | null;
            tipBeneficiaryUserId: string | null;
            revenueCategory: string;
          }>
        >`
          SELECT id, "tenantId", status, "amountCents", "availableAmountCents",
                 "providerTxId", provider, "createdByUserId", "walletId",
                 "tipCents", "tipGoesTo", "tipBeneficiaryUserId",
                 "revenueCategory"
            FROM payments
           WHERE id = ${paymentId}::uuid
           FOR UPDATE
        `;

        const p = rows[0];
        if (!p) throw new NotFoundException(`Payment ${paymentId} not found`);

        // Defensa cross-tenant: si el caller pasó tenantId, verificar coincidencia.
        // Usamos NotFoundException (no Forbidden) para no filtrar existencia del pago.
        if (expectedTenantId && p.tenantId !== expectedTenantId) {
          this.logger.warn(
            `transition tenant mismatch payment=${paymentId} expected=${expectedTenantId} actual=${p.tenantId}`,
          );
          throw new NotFoundException(`Payment ${paymentId} not found`);
        }

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
                 provider = ${(result.nextContext.provider ?? p.provider) as 'WIPAY' | 'PEANPE' | 'PAYTEF' | null}::"Provider",
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

        // Resuelve la comisión efectiva (bps) para el creator OPERATOR según
        // la categoría y los overrides:
        //   CHICA_SERVICE → User.commissionBps si está, else venue[CHICA_SERVICE]
        //   VENUE_*       → siempre venue[<categoría>] (ingreso del local, no de chica)
        const resolveBpsForOperator = (category: string): number => {
          if (category === 'CHICA_SERVICE' && creatorCommissionBps !== null) {
            return creatorCommissionBps;
          }
          return venueCommissionMap[category] ?? 0;
        };

        // Hook de earning para OPERATOR — si transitamos a AUTHORIZED y el creador
        // del payment es una operadora, snapshot de comisión en operator_earnings.
        // Math.round (no floor) evita bias unidireccional contra la operadora —
        // el céntimo perdido por redondeo se reparte 50/50 estadísticamente.
        // Idempotente: la unique en paymentId rechaza un segundo insert (defensa
        // contra una transición duplicada que la FSM ya filtra).
        // NOTA: si p.walletId está set, NO generamos earning aquí — el earning
        // se genera per-consumption en wallets.service (chica cobra granular).
        if (result.nextState === 'AUTHORIZED' && p.createdByUserId && !p.walletId) {
          const bpsForOperator = resolveBpsForOperator(p.revenueCategory);
          // Solo creamos earning si:
          //   - creator es OPERATOR
          //   - bps resolvidos > 0 (en VENUE_* con default 0 no hay earning)
          if (creatorRole === 'OPERATOR' && bpsForOperator > 0) {
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

    try {
      // H2: expectedTenantId para defensa cross-tenant en confirmPosPayment.
      await this.transition(
        paymentId,
        { type: 'POS_CONFIRMED', posReceiptRef: dto.posReceiptRef },
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
        }>
      >`
        SELECT id, "tenantId", "commissionBps", "commissionCents", "reversedCents",
               "paymentAmountCents"
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

      // 3. Reversed total esperado tras este refund.
      const expectedTotalReversed = Math.round(
        (totalCumulative * e.commissionBps) / 10_000,
      );
      const reverseDelta = expectedTotalReversed - e.reversedCents;

      if (reverseDelta <= 0) {
        this.logger.warn(
          `Earning reversal delta non-positive payment=${paymentId} refundId=${refundId} expected=${expectedTotalReversed} current=${e.reversedCents} — skip update`,
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
          "tenantId", "earningId", "refundId", "reversedDeltaCents"
        )
        VALUES (
          ${e.tenantId}::uuid,
          ${e.id}::uuid,
          ${refundId}::uuid,
          ${Math.max(0, reverseDelta)}::int
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
