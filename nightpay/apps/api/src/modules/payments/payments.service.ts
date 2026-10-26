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
import { Prisma } from '@nightpay/db';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { ClsService } from 'nestjs-cls';
import { randomBytes, randomUUID } from 'node:crypto';
import * as QRCode from 'qrcode';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import {
  applyEvent,
  InvalidTransitionError,
  type PaymentEvent,
  type PaymentMachineState,
} from './payment.machine';
import {
  chargeRightsOf,
  formatChargeRef,
  methodsNeededForPayment,
  postRulesOf,
  paymentMethodsOf,
  type ChargeRights,
  type CreatePaymentDto,
  type CreatedPaymentResponse,
  type PublicPaymentView,
} from '@nightpay/contracts';
import type { RequestContext } from '../../common/context/request-context';
import { inVenue } from '../../common/context/in-venue';
import { QR_EXPIRE_QUEUE, ORPHAN_RECONCILE_QUEUE } from '../queues/queue-tokens';
import { enqueueOrphanReconcile } from '../queues/orphan-enqueue';
import { GatewayRegistry } from '../gateways/gateway.registry';
import { isTransientGatewayError } from '../gateways/gateway-errors';
import { PeanpeAdapter } from '../gateways/peanpe.adapter';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { MetricsService } from '../metrics/metrics.service';
import { VENUE_PAUSE_SELECT, assertVenueNotPaused } from '../venues/venue-pause';
import { TipsDisabledException, VENUE_METHODS_SELECT, assertMethodsEnabled } from '../venues/venue-methods';
import { resolveBpsForOperator, type OperatorCommissionDefaults, type RevenueCategory } from './commission';
import { lineCommission, lineViews, type DraftLine } from './charge-lines';
import { linesWithOperatorBps, resolveChargeOrThrow, type LineWithBps } from './charge-request';
import { insertChargeLines, insertInvitationEarnings, linesOf, nextChargeRef } from './charge-store';
import { invitationEarnings } from './invitation-lines';
import { assertCanTopUp, tipsForbidden } from '../venues/charge-rights';
import type { AuthorizeResult, Provider } from '@nightpay/contracts';
import {
  PAID_STATES,
  choosePayPage,
  decideRedsysRetry,
  freshPendingOrder,
  retryOutcome,
  settledPayView,
  switchesMethod,
  type CheckoutChoice,
  type PayablePayment,
  type PayMethodChoice,
  type PayRedirect,
  type PayReceiptView,
  type PayResultView,
  type RetryDecision,
} from './pay-redirect';
import {
  creatorTipConfirmable,
  defaultTipGoesTo,
  maxTipCents,
  readChargedTip,
  settleChargedTip,
  tipChoiceAllowed,
  tipDestinationAllowed,
  tipGoesToStaff,
} from './tip';
import { expectedChicaReversal } from './refund-share';
import { operatorCapProblem } from './operator-cap';
import { insertEmptyWallet } from '../wallets/empty-wallet';
import { firstTopUp } from '../wallets/wallet-fresh-topup';
import { WalletBlockedException } from '../wallets/wallet-blocked';
import { formatWalletCode, newWalletCode } from '../wallets/wallet-rules';
import { selfTopUpClaimHash } from '../wallets/wallet-topup-rules';
import { idempotencyHashOf, sameIdempotentRequest } from './idempotency';
import {
  findCreditTarget,
  shortCodeOnCredit,
  skippedCreditDetail,
  type CreditSkipCause,
  type CreditWalletRow,
} from './topup-credit';
import { BRAND_NAME } from '../../common/brand';
import { isOtherOrder, markAttemptApproved, recordSecondApproval } from './second-approval';
import { sweepUnpaidTopUpWallet } from './topup-wallet-sweep';
import { closeLinkedSaldo } from './cobro-link';

const POS_AUTH_CODE_REUSED =
  'Ese código de autorización ya se usó en otro cobro de este datáfono. Revisa el ticket.';
/**
 * Confirmar un cobro del datáfono pasado su plazo (30 min). Normalmente ya lo
 * ha caducado su trabajo; si ese trabajo no llegó a correr, tampoco se da por
 * pagado (antes sí, con el código que se tecleara y la hora de ahora).
 */
export const POS_PAYMENT_EXPIRED =
  'Este cobro ha caducado y ya no se puede confirmar: que la chica cree otro. Si ya pasaste la tarjeta, avisa al encargado.';
/** Un código de autorización no confirma dos cobros del mismo datáfono en este tiempo. */
const POS_AUTH_CODE_WINDOW_MS = 24 * 3600 * 1000;

/**
 * Errores de la pasarela para quien paga (endpoints públicos), sin el detalle
 * (puede llevar lo que se mandó al banco: va al log). El `code` dice qué
 * página enseña /pay (payErrorKeyOf) y el estado del cobro va con él:
 *  - GATEWAY_RETRY: fallo pasajero y nada llegó al banco. El cobro sigue como
 *    estaba (se puede pagar): «el banco no responde» con «Intentar otra vez».
 *  - GATEWAY_FAILED: definitivo antes de ir al banco. El cobro queda FAILED:
 *    «no se ha podido abrir el pago», pedir otro al personal (sin reintentar).
 *  - GATEWAY_FAILED_AFTER_ATTEMPT: definitivo al abrir OTRO intento. El cobro
 *    sigue AUTHORIZING (un intento anterior puede seguir en el banco): sin
 *    reintentar y sin decir que no se cobró nada.
 */
export const GATEWAY_ERROR_PUBLIC = 'No se pudo abrir el pago en la pasarela. Inténtalo de nuevo en unos segundos.';
export const GATEWAY_FAILED_PUBLIC = 'No se pudo abrir el pago. Pide un cobro nuevo al personal.';
export const GATEWAY_FAILED_AFTER_ATTEMPT_PUBLIC =
  'No se pudo abrir otro intento de pago. Si ves el cargo en tu banco, enséñaselo al personal; si no, pide un cobro nuevo.';
export const GATEWAY_RETRY_CODE = 'GATEWAY_RETRY';
export const GATEWAY_FAILED_CODE = 'GATEWAY_FAILED';
export const GATEWAY_FAILED_AFTER_ATTEMPT_CODE = 'GATEWAY_FAILED_AFTER_ATTEMPT';
const PAYMENT_ALREADY_STARTED = 'Payment cannot start authorization (already in progress?)';

const gatewayRetry = (): ConflictException =>
  new ConflictException({ message: GATEWAY_ERROR_PUBLIC, code: GATEWAY_RETRY_CODE });
const gatewayFailed = (): ConflictException =>
  new ConflictException({ message: GATEWAY_FAILED_PUBLIC, code: GATEWAY_FAILED_CODE });
const gatewayFailedAfterAttempt = (): ConflictException =>
  new ConflictException({ message: GATEWAY_FAILED_AFTER_ATTEMPT_PUBLIC, code: GATEWAY_FAILED_AFTER_ATTEMPT_CODE });

/** Estados desde los que se abre el primer pago en la pasarela. */
const OPENABLE_STATES: ReadonlySet<string> = new Set(['CREATED', 'AWAITING_CAPTURE']);

/** authorize() de la pasarela falló: pasajero o definitivo (gateway-errors.ts). */
class CheckoutNotOpenedError extends Error {
  readonly transient: boolean;

  constructor(cause: unknown) {
    super((cause as Error)?.message || 'unknown');
    this.name = 'CheckoutNotOpenedError';
    this.transient = isTransientGatewayError(cause);
  }
}

/** Lo que abrió la pasarela, para guardarlo con el intento. */
interface OpenedCheckout {
  result: AuthorizeResult;
  chargeCents: number;
  tipCents: number | null;
}

const TIP_TOO_HIGH = 'La propina no puede pasar del importe del cobro ni de 500,00 €';
const TIP_DESTINATION_NOT_ALLOWED = 'Desde tu app la propina solo puede ser para ti o para el local';

/** Propina que se apunta al crear el cobro (la que pone quien lo crea). */
interface CreatorTip {
  tipCents: number;
  tipGoesTo: string | null;
  tipBeneficiaryUserId: string | null;
  /** Propina pedida que no se apunta (la pasarela no la cobraría). */
  ignoredCents: number;
}

const NO_TIP: CreatorTip = { tipCents: 0, tipGoesTo: null, tipBeneficiaryUserId: null, ignoredCents: 0 };

const IDEMPOTENCY_KEY_REUSED =
  'Esa Idempotency-Key ya se usó para otro cobro (de otra persona o con otros datos). Usa una clave nueva.';

/**
 * Servicio de la carta del que sale el cobro (Fase 1A): uno solo, como antes;
 * con varias cosas, solo el resumen («2× Copa · Habitación»).
 */
interface ServiceSnapshot {
  serviceItemId: string | null;
  serviceName: string | null;
  durationMin: number | null;
}

/** Saldo de una recarga: uno que ya existe o uno nuevo que se crea con el cobro. */
type TopUpWallet =
  | { walletId: string }
  | { create: { identifier: string | null; walletGroup: string | null } };

export interface CreatePaymentOptions {
  /**
   * Recarga cobrada en la recepción del datáfono PAX (pos-device/reception):
   * sin persona, con el datáfono como terminal; necesita «Datáfono» y «Saldo»
   * encendidos (no el QR con tarjeta) y espera lo de un cobro por datáfono.
   */
  viaDevice?: { terminalId: string };
}

/** Cobro validado, listo para guardar. */
interface PaymentDraft {
  terminalId: string;
  amountCents: number;
  service: ServiceSnapshot | null;
  tip: CreatorTip;
  /** La sección con más importe (las líneas dicen el resto). */
  revenueCategory: RevenueCategory;
  /** Las líneas del cobro, cada una en su sección y con el % de la chica (vacío en una recarga). */
  lines: LineWithBps[];
  captureMethod: string | null;
  topUp: TopUpWallet | null;
  ttlSeconds: number;
  platformCommissionBps: number;
  /** % de la chica fijado al crear (#54); null si no lo crea una chica. */
  operatorCommissionBps: number | null;
  /** Cobro único: también se puede pagar con el saldo (cobro del saldo enlazado). */
  withSaldo: boolean;
  /** Cobro único: la propina que pidió el cliente, la que paga si paga con el saldo. */
  saldoTipCents: number;
}

/**
 * Saldo bloqueado (FOR UPDATE) para sumarle una recarga. Con tenantId, solo
 * el de ese local (H3); sin él, el saldo bueno de una fusión (puede ser de
 * otro local del grupo: lo comprueba findCreditTarget).
 */
async function lockCreditWallet(
  tx: TransactionalClient,
  walletId: string,
  tenantId: string | null,
): Promise<CreditWalletRow | null> {
  const rows = tenantId
    ? await tx.$queryRaw<CreditWalletRow[]>`
        SELECT id::text AS id, "tenantId"::text AS "tenantId", "walletGroup", "balanceCents",
               status::text AS status, "mergedIntoId"::text AS "mergedIntoId", "shortCode", "blockedAt"
          FROM client_wallets
         WHERE id = ${walletId}::uuid AND "tenantId" = ${tenantId}::uuid
         FOR UPDATE
      `
    : await tx.$queryRaw<CreditWalletRow[]>`
        SELECT id::text AS id, "tenantId"::text AS "tenantId", "walletGroup", "balanceCents",
               status::text AS status, "mergedIntoId"::text AS "mergedIntoId", "shortCode", "blockedAt"
          FROM client_wallets
         WHERE id = ${walletId}::uuid
         FOR UPDATE
      `;
  return rows[0] ?? null;
}

/** Saldo de una recarga tal como lo leen las páginas de /pay. */
interface PayerWalletRow {
  qrToken: string;
  shortCode: string | null;
  pinHash: string | null;
  _count: { passkeys: number };
}

/**
 * Lo del saldo que ve quien paga una recarga:
 *  - la que creó el saldo: su enlace, su código y su Face ID (solo al
 *    navegador del intento que aprobó el banco);
 *  - una empezada por el cliente en /w: solo la vuelta a ese saldo, al
 *    navegador que la empezó (su cookie de vuelta, en la Idempotency-Key);
 *  - otra recarga de un saldo que ya existía: nada (no se lleva su código,
 *    su enlace ni su Face ID).
 */
export function payerWalletFields(args: {
  wallet: PayerWalletRow | null;
  firstTopUp: boolean;
  idempotencyKey: string | null | undefined;
  approvedClaimHash: string | null;
}): Pick<
  PayablePayment,
  'walletToken' | 'walletClaimHash' | 'walletCode' | 'walletHasFaceId' | 'walletHasPin' | 'walletReturnToken'
> {
  const returnClaimHash = args.wallet ? selfTopUpClaimHash(args.idempotencyKey) : null;
  const wallet = args.wallet && args.firstTopUp && !returnClaimHash ? args.wallet : null;
  return {
    walletToken: wallet?.qrToken ?? null,
    walletClaimHash: returnClaimHash ?? (wallet ? args.approvedClaimHash : null),
    walletCode: wallet?.shortCode ? formatWalletCode(wallet.shortCode) : null,
    walletHasFaceId: (wallet?._count.passkeys ?? 0) > 0,
    walletHasPin: Boolean(wallet?.pinHash),
    ...(returnClaimHash && args.wallet ? { walletReturnToken: args.wallet.qrToken } : {}),
  };
}

/** Choque con la Idempotency-Key de otro cobro creado a la vez (P2002). */
function isIdempotencyKeyClash(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  return JSON.stringify(err.meta?.target ?? '').includes('idempotencyKey');
}

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
  /** % de la chica fijado al crear el cobro (null en cobros anteriores). */
  operatorCommissionBps?: number | null;
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
   * cualquier job ya en cola (uno fallido se quita antes: orphan-enqueue.ts).
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
        // Disparo inminente al boot. Si su trabajo anterior agotó los
        // reintentos, se quita antes (si no, add() con el mismo id no hace nada).
        await enqueueOrphanReconcile(this.orphanReconcileQueue, this.logger, { paymentId: p.id, tenantId: p.tenantId }, 5000);
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
   * Crea un pago. Idempotente: la misma Idempotency-Key de la misma persona
   * con la misma petición → el mismo pago. Con otra persona u otra petición →
   * 409 (antes devolvía el cobro de otra persona, con su QR, o un cobro
   * antiguo distinto del pedido).
   */
  async create(
    tenantId: string,
    idempotencyKey: string,
    dto: CreatePaymentDto,
    actor?: { userId: string; role: string },
    opts: CreatePaymentOptions = {},
  ): Promise<CreatedPaymentResponse> {
    const ctx = this.cls.get('ctx');
    const creatorUserId = actor?.userId ?? ctx?.userId ?? null;
    const creatorRole = actor?.role ?? ctx?.role;
    const requestHash = idempotencyHashOf(creatorUserId, dto);

    // 1. La misma petición repetida → el mismo cobro.
    const replayed = await this.replayIdempotent(tenantId, idempotencyKey, requestHash, creatorUserId);
    if (replayed) return replayed;

    // 2. Validar y resolver todo antes de escribir nada.
    const draft = await this.draftPayment(tenantId, dto, { userId: creatorUserId, role: creatorRole }, opts.viaDevice);

    // 3. Cobro + evento inicial (+ saldo nuevo de una recarga) — atómico.
    let payment: { id: string; amountCents: number };
    try {
      payment = await this.insertPayment({ tenantId, idempotencyKey, requestHash, creatorUserId, dto, draft });
    } catch (err) {
      // Dos peticiones a la vez con la misma clave: gana una y la otra
      // devuelve ese cobro (si es la misma petición) en vez de un 500.
      if (!isIdempotencyKeyClash(err)) throw err;
      const raced = await this.replayIdempotent(tenantId, idempotencyKey, requestHash, creatorUserId);
      if (raced) return raced;
      throw err;
    }

    // 4. Encolar job de expiración (id determinista → idempotente al encolar).
    //    Con reintentos: un fallo pasajero (base ocupada) no deja el cobro
    //    CREATED. Si ni así (o Redis falló aquí y el reintento del cliente
    //    devuelve el cobro sin volver a encolar), lo caduca QrExpireSweepService.
    await this.qrExpireQueue.add(
      'qr-expire',
      { paymentId: payment.id, tenantId },
      {
        jobId: `qr-expire-${payment.id}`,
        // H7: usar el TTL calculado para este payment (5min QR / 30min POS),
        // antes era siempre QR_TTL_SECONDS → POS expiraba a los 5min con el
        // camarero todavía en camino al datáfono.
        delay: draft.ttlSeconds * 1000,
        attempts: 3,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );

    this.metrics.paymentsCreated.inc({ venue: tenantId, provider: 'pending' });
    this.logger.log(`Payment created ${payment.id} amount=${payment.amountCents} venue=${tenantId}`);
    return this.toCreatedResponse(payment.id);
  }

  /** Cobro ya creado con esta clave: el mismo si es la misma petición; si no, 409. */
  private async replayIdempotent(
    tenantId: string,
    idempotencyKey: string,
    requestHash: string,
    creatorUserId: string | null,
  ): Promise<CreatedPaymentResponse | null> {
    const existing = await this.prisma.asSystem((tx) =>
      tx.payment.findUnique({
        where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } },
        select: { id: true, idempotencyHash: true, createdByUserId: true },
      }),
    );
    if (!existing) return null;
    if (!sameIdempotentRequest(existing, requestHash, creatorUserId)) {
      this.logger.warn(`Idempotency-Key reutilizada con otra petición: key=${idempotencyKey} payment=${existing.id}`);
      throw new ConflictException(IDEMPOTENCY_KEY_REUSED);
    }
    this.logger.log(`Idempotent hit: key=${idempotencyKey} → payment=${existing.id}`);
    return this.toCreatedResponse(existing.id);
  }

  /** Lo que se va a guardar, ya validado (sin escribir nada todavía). */
  private async draftPayment(
    tenantId: string,
    dto: CreatePaymentDto,
    creator: { userId: string | null; role: string | undefined },
    viaDevice?: { terminalId: string },
  ): Promise<PaymentDraft> {
    const creatorRole = creator.role;
    // Recarga en la recepción del datáfono: el cobro es de ese datáfono.
    const terminalId = viaDevice?.terminalId ?? (await this.resolveTerminalId(tenantId, dto));
    const isWalletTopUp = Boolean(dto.wallet);
    const isPosExternal = dto.captureMethod === 'POS_EXTERNAL';
    // Con la app del datáfono el resultado llega del propio aparato (no de un
    // camarero): se cobra con el datáfono y la recarga se suma al confirmarlo.
    const byDatafono = isPosExternal || viaDevice !== undefined;
    // Leemos el venue siempre (necesitamos platformCommissionBps para snapshot).
    const venue = await this.prisma.asSystem((tx) =>
      tx.venue.findUniqueOrThrow({
        where: { id: tenantId },
        select: {
          operatorMaxCobroCents: true,
          platformCommissionBps: true,
          operatorCommissionDefaults: true,
          walletGroup: true,
          ...VENUE_PAUSE_SELECT,
          ...VENUE_METHODS_SELECT,
        },
      }),
    );
    // Local (o su negocio) en pausa: ni cobros ni recargas nuevos (423 VENUE_PAUSED).
    assertVenueNotPaused(venue);
    // Forma de cobro apagada en Ajustes (QR con tarjeta, datáfono; la recarga
    // también necesita el saldo): 409 PAYMENT_METHOD_DISABLED.
    const methods = assertMethodsEnabled(venue, methodsNeededForPayment({ isWalletTopUp, isPosExternal: byDatafono }));
    // Las recargas del saldo, solo en recepción (el puesto), el encargado, el
    // dueño o el datáfono de recepción. El cliente desde /w no tiene persona.
    if (isWalletTopUp && !viaDevice && creator.userId) await this.assertCanTopUp(tenantId, creator.userId, creatorRole);
    const { amountCents, service, revenueCategory, lines, fromCarta, rights } = await this.resolveCharge(tenantId, dto, creator);

    // Propina que pone quien crea el cobro: solo si el banco la va a cobrar y
    // confirmar (Redsys); por datáfono cuenta la del datáfono. Y el tope del
    // local para la chica es sobre importe + propina. Con las propinas
    // apagadas en el local, 409 TIPS_DISABLED.
    if ((dto.tipCents ?? 0) > 0 && !methods.tips) throw new TipsDisabledException();
    // Y su puesto tiene que llevar propinas (recepción, no).
    if ((dto.tipCents ?? 0) > 0 && rights && !rights.tips) throw tipsForbidden();
    const tip = await this.resolveCreatorTip({ tenantId, dto, amountCents, creatorRole, isPosExternal, isWalletTopUp });
    const capProblem = operatorCapProblem({
      creatorRole,
      isWalletTopUp,
      fromMenu: fromCarta,
      amountCents,
      tipCents: tip.tipCents,
      capCents: venue.operatorMaxCobroCents,
    });
    if (capProblem) throw new BadRequestException(capProblem);

    // Mutex: no se puede top-upear wallet via POS_EXTERNAL (PSP externo no nos
    // notifica AUTHORIZED por webhook → no podríamos creditar el wallet).
    if (isPosExternal && isWalletTopUp) {
      throw new BadRequestException('No se puede recargar el saldo con un datáfono externo: usa el QR.');
    }
    const topUp = await this.resolveTopUp(tenantId, dto, venue.walletGroup);
    const commission = await this.operatorCommissionSnapshot({
      creator,
      isWalletTopUp,
      lines,
      venueMap: venue.operatorCommissionDefaults as Partial<OperatorCommissionDefaults> | null,
    });
    return {
      terminalId,
      amountCents,
      service,
      tip,
      revenueCategory,
      lines: commission.lines,
      captureMethod: isWalletTopUp ? 'WALLET_TOPUP' : (dto.captureMethod ?? null),
      topUp,
      // POS_EXTERNAL puede tardar más en confirmarse (camarero camina con el
      // datáfono) — TTL más generoso. Wallet topup y QR normal: 5 min default.
      ttlSeconds: byDatafono ? POS_QR_TTL_SECONDS : QR_TTL_SECONDS,
      platformCommissionBps: venue.platformCommissionBps,
      operatorCommissionBps: commission.paymentBps,
      // Cobro único: con el saldo encendido en el local y quien cobra con
      // nombre (el cobro del saldo es suyo). Ni recargas ni datáfono.
      withSaldo: Boolean(dto.withSaldo) && !isWalletTopUp && !byDatafono && methods.wallet && creator.userId !== null,
      saldoTipCents: this.saldoTip(dto, amountCents),
    };
  }

  /**
   * Cobro único con propina (la loseta «Propina»): con el saldo se paga entera
   * (con tarjeta, la de la página de pago, que ya sale marcada). Hasta el
   * importe y 500 €; las propinas apagadas o el puesto sin propinas ya dieron
   * 409/403 antes.
   */
  private saldoTip(dto: CreatePaymentDto, amountCents: number): number {
    const tip = dto.withSaldo ? (dto.tipCents ?? 0) : 0;
    if (tip > maxTipCents(amountCents)) throw new BadRequestException(TIP_TOO_HIGH);
    return tip;
  }

  /**
   * #54: el % de la chica se fija al crear el cobro, por línea (Servicios: su
   * commissionBps o el del local; el resto de secciones: el del local). Antes
   * se leía al pagarse: un cambio de % mientras el cliente pagaba se aplicaba
   * a un cobro ya creado. Recargas de saldo: la comisión va por consumo.
   */
  private async operatorCommissionSnapshot(args: {
    creator: { userId: string | null; role: string | undefined };
    isWalletTopUp: boolean;
    lines: readonly DraftLine[];
    venueMap: Partial<OperatorCommissionDefaults> | null;
  }): Promise<{ lines: LineWithBps[]; paymentBps: number | null }> {
    const { userId, role } = args.creator;
    if (role !== 'OPERATOR' || !userId || args.isWalletTopUp) return linesWithOperatorBps(args.lines, null);
    const user = await this.prisma.asSystem((tx) =>
      tx.user.findFirst({ where: { id: userId }, select: { commissionBps: true } }),
    );
    return linesWithOperatorBps(args.lines, { commissionBps: user?.commissionBps ?? null, venueMap: args.venueMap });
  }

  /**
   * Datáfono del cobro:
   *  - Si dto.terminalExternalId: lookup directo (backwards compat).
   *  - Si dto.zone (sin externalId): cualquier terminal activo de esa zona.
   *    Si no hay → 400 con mensaje claro.
   *  - Si ambos: terminalExternalId gana.
   */
  private async resolveTerminalId(tenantId: string, dto: CreatePaymentDto): Promise<string> {
    if (dto.terminalExternalId) {
      const externalId = dto.terminalExternalId;
      const terminal = await this.prisma.asSystem((tx) =>
        tx.terminal.findUnique({ where: { tenantId_externalId: { tenantId, externalId } } }),
      );
      if (!terminal || !terminal.active) {
        throw new BadRequestException(`Terminal '${externalId}' not found or inactive`);
      }
      return terminal.id;
    }
    if (!dto.zone) {
      throw new BadRequestException('Debes pasar terminalExternalId o zone para resolver el datáfono');
    }
    // Normalizamos: si zone=OTRO, el canonical zone es 'OTRO/<zoneCustom>'.
    const canonicalZone =
      dto.zone === 'OTRO' && dto.zoneCustom ? `OTRO/${dto.zoneCustom.trim().toUpperCase()}` : dto.zone;
    const terminal = await this.prisma.asSystem((tx) =>
      tx.terminal.findFirst({
        where: { tenantId, zone: canonicalZone, active: true },
        // Terminal model no tiene timestamps; ordenamos por externalId estable.
        orderBy: { externalId: 'asc' },
      }),
    );
    if (!terminal) {
      throw new BadRequestException(
        `No hay PAX activos en zona '${canonicalZone}'. Revisa con el admin que haya terminales dados de alta y activos.`,
      );
    }
    return terminal.id;
  }

  /**
   * Lo que se cobra, en líneas (el mapa del dinero): de la carta (importe y
   * sección los fija el local; un pack, una línea por parte) o tecleado en
   * una sección. Sin sección pedida, la del puesto de quien cobra o la de su
   * rol: nunca «Otros». Una recarga de saldo no es una venta: sin líneas.
   */
  private async resolveCharge(
    tenantId: string,
    dto: CreatePaymentDto,
    creator: { userId: string | null; role: string | undefined },
  ): Promise<{
    amountCents: number;
    service: ServiceSnapshot | null;
    revenueCategory: RevenueCategory;
    lines: DraftLine[];
    fromCarta: boolean;
    rights: ChargeRights | null;
  }> {
    if (dto.wallet) {
      if (!dto.amountCents) throw new BadRequestException('Pon el importe');
      return { amountCents: dto.amountCents, service: null, revenueCategory: 'EXTRA', lines: [], fromCarta: false, rights: null };
    }
    const charge = await resolveChargeOrThrow(this.prisma, {
      tenantId,
      userId: creator.userId,
      role: creator.role,
      lines: dto.lines,
      serviceItemId: dto.serviceItemId,
      amountCents: dto.amountCents,
      requestedCategory: dto.revenueCategory,
      invitedStaffToken: dto.invitedStaffToken,
      invitedOperatorId: dto.invitedOperatorId,
    });
    const service: ServiceSnapshot | null =
      charge.service ?? (charge.serviceName ? { serviceItemId: null, serviceName: charge.serviceName, durationMin: null } : null);
    return {
      amountCents: charge.amountCents,
      service,
      revenueCategory: charge.primaryCategory,
      lines: charge.lines,
      fromCarta: charge.fromCarta,
      rights: charge.rights,
    };
  }

  /** 403 «Las recargas se hacen en recepción» si su puesto no carga saldos. */
  private async assertCanTopUp(tenantId: string, userId: string, role: string | undefined): Promise<void> {
    await this.prisma.asSystem((tx) => assertCanTopUp(tx, tenantId, { userId, role }));
  }

  /**
   * Phase 1B — recarga de saldo. walletId:<id> → valida que es de este local y
   * está activo o a cero (DEPLETED: al cobrarse vuelve a estar activo, como en
   * topup-credit; uno sumado a otro, no). create:true → el saldo nuevo se crea
   * al guardar el cobro, en la misma transacción (antes se creaba antes y
   * quedaba huérfano si el cobro fallaba).
   */
  private async resolveTopUp(
    tenantId: string,
    dto: CreatePaymentDto,
    walletGroup: string | null,
  ): Promise<TopUpWallet | null> {
    const walletDto = dto.wallet;
    if (!walletDto) return null;
    if ('create' in walletDto) return { create: { identifier: walletDto.identifier ?? null, walletGroup } };
    const existing = await this.prisma.asSystem((tx) =>
      tx.clientWallet.findFirst({
        where: { id: walletDto.walletId, tenantId },
        select: { id: true, status: true, mergedIntoId: true, blockedAt: true },
      }),
    );
    if (!existing) throw new NotFoundException('Saldo no encontrado en este local');
    // Bloqueado por el super-admin: ni con tarjeta (como en efectivo, en recepción o desde /w).
    if (existing.blockedAt) throw new WalletBlockedException();
    // A 0 (DEPLETED) se recarga y se reabre al cobrarse; sumado a otro o cerrado, no.
    const rechargeable = existing.status === 'ACTIVE' || (existing.status === 'DEPLETED' && !existing.mergedIntoId);
    if (!rechargeable) {
      throw new BadRequestException('Este saldo ya está cerrado: no se puede recargar. Haz un saldo nuevo.');
    }
    return { walletId: existing.id };
  }

  private async insertPayment(input: {
    tenantId: string;
    idempotencyKey: string;
    requestHash: string;
    creatorUserId: string | null;
    dto: CreatePaymentDto;
    draft: PaymentDraft;
  }): Promise<{ id: string; amountCents: number }> {
    const { tenantId, draft, dto } = input;
    const { tipCents, tipGoesTo, tipBeneficiaryUserId, ignoredCents } = draft.tip;
    const qrExpiresAt = new Date(Date.now() + draft.ttlSeconds * 1000);
    return this.prisma.asSystem(async (tx) => {
      const walletId = await this.topUpWalletId(tx, tenantId, draft.topUp);
      // Referencia corta (C-0001): el contador del local queda bloqueado hasta el commit.
      const ref = await nextChargeRef(tx, tenantId);
      const p = await tx.payment.create({
        data: {
          tenantId,
          ref,
          terminalId: draft.terminalId,
          createdByUserId: input.creatorUserId,
          idempotencyKey: input.idempotencyKey,
          idempotencyHash: input.requestHash,
          amountCents: draft.amountCents,
          // availableAmountCents incluye tip — refunds pueden cubrir todo.
          availableAmountCents: draft.amountCents + tipCents,
          currency: dto.currency,
          status: 'CREATED',
          qrToken: randomUUID(),
          qrExpiresAt,
          // Snapshot del % plataforma al momento del cobro (contabilidad histórica
          // estable aunque el venue cambie el % mañana).
          platformCommissionBps: draft.platformCommissionBps,
          operatorCommissionBps: draft.operatorCommissionBps,
          tipCents,
          revenueCategory: draft.revenueCategory,
          ...(tipGoesTo ? { tipGoesTo } : {}),
          ...(tipBeneficiaryUserId ? { tipBeneficiaryUserId } : {}),
          ...(draft.captureMethod ? { captureMethod: draft.captureMethod } : {}),
          ...(walletId ? { walletId } : {}),
          ...(draft.service ?? {}),
        },
        select: { id: true, amountCents: true },
      });
      await insertChargeLines(tx, tenantId, { paymentId: p.id }, draft.lines);
      // Cobro único: la otra forma de pagar este mismo cobro (NFC, PIN o Face
      // ID), con su importe, su referencia y su plazo. Las líneas se quedan en
      // el cobro con tarjeta hasta que paga el saldo (cobro-link.ts).
      const saldo =
        draft.withSaldo && input.creatorUserId
          ? await tx.walletChargeRequest.create({
              data: {
                tenantId,
                walletId: null,
                requestedByUserId: input.creatorUserId,
                amountCents: draft.amountCents,
                category: draft.revenueCategory,
                serviceName: draft.service?.serviceName ?? null,
                payToken: randomBytes(24).toString('base64url'),
                ref,
                expiresAt: qrExpiresAt,
                linkedPaymentId: p.id,
                tipCents: draft.saldoTipCents,
              },
              select: { id: true },
            })
          : null;
      await tx.paymentEvent.create({
        data: {
          paymentId: p.id,
          tenantId,
          eventType: 'payment.created',
          payload: {
            amountCents: p.amountCents,
            tipCents,
            ...(ignoredCents > 0 ? { tipIgnoredCents: ignoredCents } : {}),
            terminal: dto.terminalExternalId,
            walletId,
            ...(saldo ? { saldoChargeId: saldo.id } : {}),
          },
          traceId: this.cls.get('ctx')?.traceId ?? randomUUID(),
        },
      });
      return p;
    });
  }

  private async topUpWalletId(
    tx: TransactionalClient,
    tenantId: string,
    topUp: TopUpWallet | null,
  ): Promise<string | null> {
    if (!topUp) return null;
    if ('walletId' in topUp) return topUp.walletId;
    return this.insertEmptyWallet(tx, tenantId, topUp.create);
  }

  /** Saldo vacío para una recarga, dentro de la transacción del cobro (wallets/empty-wallet). */
  private async insertEmptyWallet(
    tx: TransactionalClient,
    tenantId: string,
    input: { identifier: string | null; walletGroup: string | null },
  ): Promise<string> {
    const id = await insertEmptyWallet(tx, tenantId, input);
    this.logger.log(`Wallet created id=${id} tenant=${tenantId} identifier=${input.identifier ?? '-'}`);
    return id;
  }

  /**
   * Propina que pone quien crea el cobro. Solo se apunta si el banco la va a
   * cobrar y confirmar (Redsys, cobro con QR); si no, 0 (antes quedaba como
   * propina de la chica y devolvible sin que nadie la hubiera pagado). Como
   * mucho el importe (y 500 €); la chica, solo para ella o para el local.
   */
  private async resolveCreatorTip(input: {
    tenantId: string;
    dto: CreatePaymentDto;
    amountCents: number;
    creatorRole: string | undefined;
    isPosExternal: boolean;
    isWalletTopUp: boolean;
  }): Promise<CreatorTip> {
    const { dto, tenantId } = input;
    if (!tipDestinationAllowed(input.creatorRole, dto.tipGoesTo)) {
      throw new BadRequestException(TIP_DESTINATION_NOT_ALLOWED);
    }
    const declared = dto.tipCents ?? 0;
    if (declared <= 0) return NO_TIP;
    const provider = await this.activeProvider(tenantId);
    const confirmable = creatorTipConfirmable({
      provider,
      isPosExternal: input.isPosExternal,
      isWalletTopUp: input.isWalletTopUp,
    });
    if (!confirmable) {
      this.logger.warn(
        `Propina de ${declared}c no apuntada (venue=${tenantId} provider=${provider ?? '-'}): la pasarela no la cobra`,
      );
      return { ...NO_TIP, ignoredCents: declared };
    }
    if (declared > maxTipCents(input.amountCents)) throw new BadRequestException(TIP_TOO_HIGH);
    const tipGoesTo = dto.tipGoesTo ?? defaultTipGoesTo(input.creatorRole);
    const tipBeneficiaryUserId = dto.tipBeneficiaryUserId ?? null;
    if (tipGoesTo === 'beneficiary' && !tipBeneficiaryUserId) {
      throw new BadRequestException('tipGoesTo=beneficiary requiere tipBeneficiaryUserId');
    }
    if (tipBeneficiaryUserId) await this.assertVenueUser(tenantId, tipBeneficiaryUserId);
    return { tipCents: declared, tipGoesTo, tipBeneficiaryUserId, ignoredCents: 0 };
  }

  private async assertVenueUser(tenantId: string, userId: string): Promise<void> {
    const user = await this.prisma.asSystem((tx) =>
      tx.user.findFirst({ where: { id: userId, tenantId, deletedAt: null }, select: { id: true } }),
    );
    if (!user) throw new BadRequestException('tipBeneficiaryUserId no pertenece al venue');
  }

  /** Pasarela activa del local (la que cobrará cuando el cliente pague). */
  private async activeProvider(tenantId: string): Promise<Provider | null> {
    const credential = await this.prisma.asSystem((tx) =>
      tx.gatewayCredential.findFirst({
        where: { tenantId, active: true },
        orderBy: { createdAt: 'asc' },
        select: { provider: true },
      }),
    );
    return credential?.provider ?? null;
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
    // Las sugeridas o la de «Otra», hasta el máximo para este importe.
    if (!tipChoiceAllowed(payment, choice.tipCents)) throw new BadRequestException('Propina no válida');
    // Un QR de antes de la pausa (o de apagar la forma de cobro) ya no va al banco.
    await this.assertVenueStillCharges(payment);

    if (payment.status !== 'AUTHORIZING') {
      let providerTxId: string | undefined;
      try {
        ({ providerTxId } = await this.startAuthorization(qrToken, choice));
      } catch (err) {
        // Doble toque: el otro POST (de este navegador) ya abrió el pedido → mismo formulario.
        const order = await this.freshOrderOf(payment.id, choice.claimHash ?? null);
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
          select: { providerTxId: true, status: true, createdAt: true, claimHash: true, payMethod: true },
        });
        const now = new Date();
        // Otro botón que el del intento pendiente (tarjeta tras Apple Pay): pedido nuevo.
        const switchingMethod = switchesMethod(attempts[0], choice.method);
        const fresh = switchingMethod ? null : freshPendingOrder(attempts, now, choice.claimHash ?? null);
        if (fresh) return { decision: 'replay' as const, order: fresh, attempts: attempts.length };
        const decision = decideRedsysRetry({
          attempts,
          now,
          qrExpiresAt: payment.qrExpiresAt,
          paymentUpdatedAt: payment.updatedAt,
          switchingMethod,
        });
        if (decision !== 'retry') return { decision, order: null, attempts: attempts.length };
        const opened = await this.openCheckout(payment, 'REDSYS', choice);
        await this.saveAttempt(tx, payment, 'REDSYS', opened, choice);
        return { decision, order: opened.result.providerTxId, attempts: attempts.length };
      });
    } catch (err) {
      // El detalle (puede llevar lo enviado al banco) solo al log, nunca al cliente.
      this.logger.error(`Reintento Redsys falló para ${payment.id}: ${(err as Error).message}`);
      // La transacción se deshizo: el intento nuevo no existe y el cobro sigue
      // AUTHORIZING con los de antes. Definitivo de la pasarela: no se ofrece
      // repetir (y un intento anterior puede seguir en el banco). Pasajero, o
      // la base: repetir es seguro (Redsys solo firma, sin red) y funciona.
      if (err instanceof CheckoutNotOpenedError && !err.transient) throw gatewayFailedAfterAttempt();
      throw gatewayRetry();
    }
    if (outcome.order) {
      if (outcome.decision === 'retry') {
        this.logger.log(
          `Payment ${payment.id}: nuevo intento Redsys (${outcome.attempts + 1}${choice.method ? `, ${choice.method}` : ''})`,
        );
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

  private async freshOrderOf(paymentId: string, claimHash?: string | null): Promise<string | null> {
    const attempts = await this.prisma.asSystem((tx) =>
      tx.paymentAttempt.findMany({
        where: { paymentId },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { providerTxId: true, status: true, createdAt: true, claimHash: true },
      }),
    );
    return freshPendingOrder(attempts, new Date(), claimHash);
  }

  private async findPayable(
    qrToken: string,
  ): Promise<PayablePayment & { tenantId: string; provider: Provider | null; updatedAt: Date; walletId: string | null }> {
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
          idempotencyKey: true,
          // Cabecera de la página de pago: local, concepto y a quién va la propina.
          serviceName: true,
          tipGoesTo: true,
          venue: { select: { name: true, paymentMethods: true, postRules: true } },
          createdBy: { select: { role: true, post: true } },
          wallet: { select: { qrToken: true, shortCode: true, pinHash: true, _count: { select: { passkeys: true } } } },
          attempts: {
            where: { status: 'APPROVED' },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { claimHash: true },
          },
          // Cobro único: «Pagar con mi saldo OxioCard» y el «Ya está pagado con tu saldo».
          linkedWalletCharge: { select: { payToken: true, status: true, expiresAt: true } },
        },
      }),
    );
    if (!payment) throw new NotFoundException('Payment not found');
    // Pasarela que cobrará: la del cobro o, si aún no ha ido al banco, la
    // activa del local. La propina solo se cobra (y se reparte) con Redsys.
    const provider = payment.provider ?? (await this.activeProvider(payment.tenantId));
    const { walletId, wallet, attempts, venue, createdBy, serviceName, tipGoesTo, idempotencyKey, linkedWalletCharge, ...rest } =
      payment;
    const firstTopUp = wallet !== null && !selfTopUpClaimHash(idempotencyKey) && (await this.isFirstTopUp(walletId, payment.id));
    // Propinas del local (Ajustes → Formas de cobro): apagadas, no se ofrecen ni se aceptan.
    const methods = paymentMethodsOf(venue?.paymentMethods);
    // Y el puesto de quien cobra (recepción no lleva propinas).
    const creatorTips = createdBy ? chargeRightsOf(createdBy, postRulesOf(venue?.postRules)).tips : true;
    return {
      ...rest,
      walletId,
      status: payment.status as PaymentMachineState,
      allowTip: provider === 'REDSYS' && walletId === null && methods.tips && creatorTips,
      tipPresets: { flatCents: methods.tipFlatCents, percents: methods.tipPercents },
      venueName: venue?.name ?? null,
      concept: serviceName ?? null,
      tipToStaff: tipGoesToStaff({ tipGoesTo: tipGoesTo ?? null, creatorRole: createdBy?.role ?? null }),
      approvedClaimHash: attempts[0]?.claimHash ?? null,
      ...payerWalletFields({ wallet, firstTopUp, idempotencyKey, approvedClaimHash: attempts[0]?.claimHash ?? null }),
      saldo: linkedWalletCharge ? { ...linkedWalletCharge, enabled: methods.wallet } : null,
    };
  }

  /**
   * ¿Es este el cobro con el que se creó (y cargó por primera vez) el saldo?
   * Cuenta también la recarga en efectivo (recepción, datáfono): en un saldo
   * abierto en efectivo, la primera recarga con tarjeta NO es la que lo creó
   * (si no, quien la pagara se llevaría su enlace, su Face ID y su saldo).
   */
  private async isFirstTopUp(walletId: string | null, paymentId: string): Promise<boolean> {
    if (!walletId) return false;
    return (await firstTopUp(this.prisma, walletId))?.paymentId === paymentId;
  }

  /**
   * Para la página /pay/result a la que vuelve el cliente desde el banco:
   * estado REAL del pago a partir del pedido de la pasarela (Ds_Order).
   */
  async getResultView(providerTxId: string): Promise<PayResultView | null> {
    if (!providerTxId) return null;
    const found = await this.prisma.asSystem(async (tx) => {
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
          walletId: true,
          idempotencyKey: true,
          wallet: { select: { qrToken: true, shortCode: true, pinHash: true, _count: { select: { passkeys: true } } } },
          attempts: {
            where: { status: 'APPROVED' },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { claimHash: true },
          },
        },
      });
      if (!payment) return null;
      const thisAttempt = await tx.paymentAttempt.findFirst({
        where: { paymentId: payment.id, providerTxId },
        select: { status: true },
      });
      return { payment, attemptStatus: thisAttempt?.status ?? null };
    });
    if (!found) return null;
    const { payment, attemptStatus } = found;
    return {
      paymentId: payment.id,
      status: payment.status as PaymentMachineState,
      amountCents: payment.amountCents,
      tipCents: payment.tipCents,
      currency: payment.currency,
      authorizedAt: payment.authorizedAt,
      qrToken: payment.qrToken,
      ...payerWalletFields({
        wallet: payment.wallet,
        firstTopUp: await this.isFirstTopUp(payment.walletId, payment.id),
        idempotencyKey: payment.idempotencyKey,
        approvedClaimHash: payment.attempts[0]?.claimHash ?? null,
      }),
      attemptStatus,
      approvedClaimHash: payment.attempts[0]?.claimHash ?? null,
    };
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
      ref: formatChargeRef(payment.ref),
      // Ya pagado: la propina que dejó (el PAGADO del personal sin tiempo real la necesita).
      ...(PAID_STATES.has(payment.status as PaymentMachineState) ? { tipCents: payment.tipCents } : {}),
    };
  }

  /**
   * Detalle completo (admin/manager vía AuthGuard + tenant filter).
   */
  async findById(paymentId: string) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Payment not found');
    // El token de la tarjeta (Redsys, cobros recurrentes) no sale nunca por la
    // API del personal (#60).
    const { tokenizationData: _token, ...rest } = payment;
    return rest;
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
    /** Segunda aprobación de un cobro ya pagado: apuntada y se rechaza tras el commit. */
    let secondApproval: { status: PaymentMachineState; tenantId: string; recorded: boolean } | undefined;

    await this.prisma.$transaction(
      async (tx) => {
        // Como asSystem: interna (avisos, trabajos, devoluciones) y sin depender
        // de que el usuario de la base sea superusuario (FORCE RLS en cobros,
        // saldos y comisiones). La defensa entre locales es expectedTenantId.
        await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
        const rows = await tx.$queryRaw<LockedPaymentRow[]>`
          SELECT id, "tenantId", status, "amountCents", "availableAmountCents",
                 "providerTxId", provider, "createdByUserId", "walletId",
                 "tipCents", "tipGoesTo", "tipBeneficiaryUserId",
                 "revenueCategory", "operatorCommissionBps"
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
        // P1: otro pedido de este cobro aprobado cuando ya estaba pagado = el
        // cliente pagó dos veces. Con la fila bloqueada (dos avisos a la vez se
        // ponen en fila) y antes de tocar la propina del cobro.
        if (event.type === 'AUTHORIZED' && isOtherOrder(base, event)) {
          const recorded = await recordSecondApproval(tx, base, event, this.cls.get('ctx')?.traceId ?? randomUUID());
          if (recorded !== null) {
            secondApproval = { status: base.status, tenantId: base.tenantId, recorded };
            return;
          }
        }
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
                 "authorizedAt" = CASE WHEN ${result.nextState}::text = 'AUTHORIZED'
                                       THEN COALESCE("authorizedAt", NOW()) ELSE "authorizedAt" END,
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

        // El intento que cobró queda APPROVED venga de donde venga la
        // aprobación (aviso, conciliación o a mano): así se ve el doble cobro
        // si luego se aprueba otro pedido del mismo cobro.
        if (event.type === 'AUTHORIZED' && result.nextState === 'AUTHORIZED') {
          await markAttemptApproved(tx, paymentId, event);
        }

        // Phase 1B — recarga de saldo cobrada: se suma al saldo ATÓMICAMENTE en
        // la misma transacción de la FSM (saldo bloqueado FOR UPDATE). El tip va
        // SEPARADO del balance: propinas no son saldo gastable por el cliente.
        if (result.nextState === 'AUTHORIZED' && p.walletId) {
          await this.creditTopUp(tx, { ...p, walletId: p.walletId }, paymentId);
        }

        // Comisión de la chica / propina a otra chica: misma transacción.
        if (result.nextState === 'AUTHORIZED') {
          await this.recordEarnings(tx, p, paymentId);
        }

        // Cobro único: pagado con la tarjeta, cancelado o caducado → su cobro
        // del saldo, si sigue pendiente, también (gana el primero: un NFC
        // acercado después contesta «Ya está pagado»). Con el cobro bloqueado.
        if (result.nextState !== p.status) {
          await closeLinkedSaldo(tx, paymentId, result.nextState);
        }

        // Recarga con «saldo nuevo» que acabó sin pagarse: su saldo vacío se cierra.
        if ((result.nextState === 'EXPIRED' || result.nextState === 'CANCELED') && p.walletId) {
          if (await sweepUnpaidTopUpWallet(tx, paymentId, p.walletId)) {
            this.logger.log(`Payment ${paymentId} ${result.nextState}: saldo vacío ${p.walletId} cerrado`);
          }
        }

        prevState = p.status;
        nextState = result.nextState;
        amountCents = p.amountCents;
        tipCents = p.tipCents;
      },
      { isolationLevel: 'ReadCommitted' },
    );

    if (secondApproval) {
      if (secondApproval.recorded && event.type === 'AUTHORIZED') {
        this.metrics.duplicateCharges.inc({ venue: secondApproval.tenantId, provider: event.provider });
        this.logger.error(
          `DOBLE COBRO payment=${paymentId}: el pedido ${event.providerTxId} también se aprobó. Devolver uno.`,
        );
      }
      // Para quien llama, como antes: el cobro ya estaba pagado (idempotente).
      throw new InvalidTransitionError(secondApproval.status, event.type);
    }

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
   * Comisión de la chica (y propina para otra chica del local) al pagarse un
   * cobro: en la misma transacción de transition(). Extraído tal cual de
   * transition() (sin cambios de lógica).
   */
  private async recordEarnings(tx: TransactionalClient, p: LockedPaymentRow, paymentId: string): Promise<void> {
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
    if (p.createdByUserId) {
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
    if (p.createdByUserId && !p.walletId) {
      // #54: el % fijado al crear el cobro; en cobros anteriores, el de ahora.
      const bpsForOperator = p.operatorCommissionBps ?? resolveBpsForOperator({
        category: p.revenueCategory,
        userCommissionBpsOverride: creatorCommissionBps,
        venueMap: venueCommissionMap as Partial<OperatorCommissionDefaults>,
      });
      // Solo creamos earning si:
      //   - creator es OPERATOR
      //   - bps resolvidos > 0 (en VENUE_* con default 0 no hay earning)
      if (creatorRole === 'OPERATOR') {
        const creator = { id: p.createdByUserId };
        // El mapa del dinero: con líneas, la comisión va por línea (cada
        // sección con su %); un cobro de una sola sección da lo de siempre.
        const lines = await tx.$queryRaw<Array<{ category: string; amountCents: number; operatorCommissionBps: number | null }>>`
          SELECT category, "amountCents", "operatorCommissionBps" FROM payment_lines WHERE "paymentId" = ${paymentId}::uuid
        `;
        const commission =
          lines.length > 0
            ? lineCommission(
                lines.map((l) => ({
                  amountCents: l.amountCents,
                  bps:
                    l.operatorCommissionBps ??
                    resolveBpsForOperator({
                      category: l.category,
                      userCommissionBpsOverride: creatorCommissionBps,
                      venueMap: venueCommissionMap as Partial<OperatorCommissionDefaults>,
                    }),
                })),
              )
            : lineCommission([{ amountCents: p.amountCents, bps: bpsForOperator }]);
        const bps = commission.commissionBps;
        const commissionCents = commission.commissionCents;

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
        if (commission.anyBps || earningTipCents > 0) {
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
            ON CONFLICT ("paymentId", "operatorId") DO NOTHING
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
          ON CONFLICT ("paymentId", "operatorId") DO NOTHING
        `;
        this.logger.log(
          `Payment ${paymentId} AUTHORIZED → tip-only earning created for beneficiary=${benef.id} amount=${p.tipCents}c`,
        );
      }
    }

    // «Copa con invitación»: la parte de la chica invitada y, si le toca, la
    // del camarero que la cobró (fijadas en la línea al cobrar).
    if (!p.walletId) {
      const invited = await tx.$queryRaw<
        Array<{ id: string; amountCents: number; beneficiaryOperatorId: string | null; beneficiaryCents: number | null; chargerCents: number | null }>
      >`
        SELECT id, "amountCents", "beneficiaryOperatorId", "beneficiaryCents", "chargerCents"
          FROM payment_lines
         WHERE "paymentId" = ${paymentId}::uuid AND "beneficiaryOperatorId" IS NOT NULL
      `;
      if (invited.length > 0) {
        await insertInvitationEarnings(tx, p.tenantId, { paymentId }, invitationEarnings(invited, p.createdByUserId));
      }
    }
  }

  /**
   * Fija en el cobro la propina del intento que cobró el banco. Sin ese dato
   * (otra pasarela, intento sin propina registrada) no hay propina: nunca la
   * que puso quien creó el cobro, que nadie ha pagado. Devuelve una copia de
   * la fila con la propina y el importe devolvible ya ajustados.
   */
  private async withChargedTip<
    T extends {
      id: string;
      amountCents: number;
      availableAmountCents: number;
      tipCents: number;
      tipGoesTo: string | null;
    },
  >(tx: TransactionalClient, p: T, event: { provider: string; providerTxId: string }): Promise<T> {
    const charged = await readChargedTip(tx, p.id, event);
    const settled = settleChargedTip({
      amountCents: p.amountCents,
      tipCents: charged?.tipCents ?? 0,
      tipGoesTo: p.tipGoesTo,
      creatorRole: charged?.creatorRole ?? null,
    });
    const unchanged =
      settled.tipCents === p.tipCents &&
      settled.availableAmountCents === p.availableAmountCents &&
      settled.tipGoesTo === p.tipGoesTo;
    if (unchanged) return p;
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
   * Recarga cobrada → se suma al saldo, dentro de transition(). Si ese saldo
   * ya se sumó a otro (Face ID), va al saldo bueno del mismo grupo (antes no
   * se sumaba a nada). Si está cerrado, incidencia: cobrado y sin saldo. No
   * lanza: un rollback dejaría el aviso del banco reintentando para siempre.
   */
  private async creditTopUp(
    tx: TransactionalClient,
    p: LockedPaymentRow & { walletId: string },
    paymentId: string,
  ): Promise<void> {
    // H3: el saldo de la recarga, bloqueado y del local del cobro.
    const first = await lockCreditWallet(tx, p.walletId, p.tenantId);
    const target = await findCreditTarget(first, (id) => lockCreditWallet(tx, id, null));
    if (!target.ok) {
      await this.reportSkippedCredit(tx, p, paymentId, target);
      return;
    }
    const w = target.wallet;
    // #56: a cero no ocupa su código; si otro saldo activo lo cogió, uno nuevo.
    const shortCode = await shortCodeOnCredit(
      w,
      async (code) =>
        (
          await tx.$queryRaw<Array<{ ok: number }>>`
            SELECT 1 AS ok FROM client_wallets
             WHERE "shortCode" = ${code} AND status = 'ACTIVE'::"WalletStatus" AND id <> ${w.id}::uuid
             LIMIT 1
          `
        ).length > 0,
      newWalletCode,
    );
    await tx.$executeRaw`
      UPDATE client_wallets
         SET "balanceCents" = "balanceCents" + ${p.amountCents}::int,
             status = 'ACTIVE'::"WalletStatus",
             "shortCode" = ${shortCode},
             "updatedAt" = now()
       WHERE id = ${w.id}::uuid
    `;
    this.logger.log(
      `Payment ${paymentId} AUTHORIZED → wallet ${w.id} credited +${p.amountCents}c (new balance: ${w.balanceCents + p.amountCents})`,
    );
    if (shortCode !== w.shortCode) {
      this.logger.warn(`Wallet ${w.id} reactivada con código nuevo (el anterior lo usaba otro saldo activo)`);
    }
    if (target.mergedFrom) {
      await tx.$executeRaw`
        INSERT INTO audit_events ("tenantId", action, "targetType", "targetId", payload, "occurredAt")
        VALUES (${p.tenantId}::uuid, 'wallet.credit_followed_merge', 'Payment', ${paymentId},
                ${JSON.stringify({ from: target.mergedFrom, to: w.id, amountCents: p.amountCents })}::jsonb, now())
      `;
    }
  }

  /**
   * C4: NO se suma la recarga pero el cliente YA pagó. Tres alertas (métrica,
   * registro ERROR y auditoría → bandeja de incidencias) con el importe, el
   * cobro y qué hacer: devolverla en el banco o reactivar el saldo.
   */
  private async reportSkippedCredit(
    tx: TransactionalClient,
    p: LockedPaymentRow & { walletId: string },
    paymentId: string,
    skip: { cause: CreditSkipCause; walletStatus: string },
  ): Promise<void> {
    const detail = skippedCreditDetail({ ...skip, amountCents: p.amountCents, paymentId });
    this.metrics.walletCreditSkipped.inc({ venue: p.tenantId, wallet_status: skip.walletStatus });
    this.logger.error(`CRITICAL: Payment ${paymentId} AUTHORIZED, wallet ${p.walletId} sin sumar — ${detail}`);
    // Audit dentro de tx — si el commit falla, el log también.
    await tx.$executeRaw`
      INSERT INTO audit_events ("tenantId", action, "targetType", "targetId", payload, "occurredAt")
      VALUES (${p.tenantId}::uuid, 'wallet.credit_skipped_critical',
              'Payment', ${paymentId},
              ${JSON.stringify({
                walletId: p.walletId,
                walletStatus: skip.walletStatus,
                amountCents: p.amountCents,
                paymentId,
                reason: 'wallet_not_active_at_authorized',
                cause: skip.cause,
                action: 'Devolver la recarga en el banco o reactivar el saldo y sumarle el importe',
                detail,
              })}::jsonb,
              now())
    `;
  }

  /**
   * Cancela un pago en estado CREATED|AWAITING_CAPTURE.
   * - OPERATOR solo puede cancelar payments creados por ella; WAITER, los suyos.
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
    // El camarero solo cancela los cobros que ha creado él (los de la chica no).
    if (actor.role === 'WAITER' && payment.createdByUserId !== actor.userId) {
      throw new ForbiddenException('Solo puedes cancelar los cobros que has creado tú');
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
    if (payment.qrExpiresAt <= new Date()) throw new ConflictException(POS_PAYMENT_EXPIRED);
    // Anti auto-confirm: la chica no se confirma sus propios POS (camarero sí).
    if (actor.role === 'OPERATOR' && payment.createdByUserId === actor.userId) {
      throw new ForbiddenException(
        'No puedes confirmar tu propio cobro POS. Llama al camarero.',
      );
    }

    const authCode = dto.posReceiptRef.replace(/\s+/g, '').toUpperCase();
    try {
      // Comprobar el código, apuntarlo con la prueba del camarero y marcar
      // pagado van en la MISMA transacción que reparte la comisión (antes eran
      // tres pasos sueltos: dos camareros podían confirmar con el mismo ticket).
      // H2: expectedTenantId para defensa cross-tenant en confirmPosPayment.
      await this.transition(
        paymentId,
        { type: 'POS_CONFIRMED', posReceiptRef: authCode },
        actor.tenantId,
        {
          prepare: (tx, locked) =>
            this.recordPosConfirmation(tx, locked, { terminalId: payment.terminalId, authCode, actor, dto }),
        },
      );
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        throw new ConflictException(
          `Payment cannot be confirmed in state ${payment.status}`,
        );
      }
      // Red del índice único (dos confirmaciones cruzadas con el mismo código).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(POS_AUTH_CODE_REUSED);
      }
      throw err;
    }

    this.logger.log(
      `Payment ${paymentId} POS_CONFIRMED by ${actor.role}=${actor.userId} ref=${dto.posReceiptRef} photo=${!!dto.posReceiptPhoto}`,
    );

    return { status: 'AUTHORIZED' };
  }

  /**
   * Dentro de la transición, con el cobro bloqueado. El código de
   * autorización identifica UNA operación del datáfono: si ya confirmó otro
   * cobro de este datáfono en las últimas 24 h es un ticket reutilizado (o un
   * error de tecleo) y no se acepta. Se apunta con la prueba del camarero
   * (ref + foto opcional: lo que demuestra el cobro si hay disputa o
   * auditoría) y sin propina: el camarero no la confirma y nadie la ha pagado.
   */
  private async recordPosConfirmation(
    tx: TransactionalClient,
    locked: LockedPaymentRow,
    input: {
      terminalId: string;
      authCode: string;
      actor: { userId: string; role: string };
      dto: { posReceiptRef: string; posReceiptPhoto?: string; notes?: string };
    },
  ): Promise<Partial<LockedPaymentRow>> {
    const { terminalId, authCode, actor, dto } = input;
    // De uno en uno por datáfono y código: el segundo espera y ve al primero.
    const lockKey = `pos-auth:${terminalId}:${authCode}`;
    await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtext(${lockKey}))`;
    const reused = await tx.payment.findFirst({
      where: {
        id: { not: locked.id },
        terminalId,
        authCode,
        authorizedAt: { gte: new Date(Date.now() - POS_AUTH_CODE_WINDOW_MS) },
      },
      select: { id: true },
    });
    if (reused) throw new ConflictException(POS_AUTH_CODE_REUSED);

    const noTip = { tipCents: 0, availableAmountCents: locked.amountCents, tipGoesTo: null };
    await tx.payment.update({
      where: { id: locked.id },
      data: { authCode, authorizedAt: new Date(), ...noTip },
    });
    await tx.paymentEvent.create({
      data: {
        paymentId: locked.id,
        tenantId: locked.tenantId,
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
    return noTip;
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
   *   gateway.authorize(): la pasarela prepara la página del banco (no cobra)
   *   ↓
   *   CREATED|AWAITING_CAPTURE → AUTHORIZING (FSM) con pedido, URL/formulario
   *   e intento, en la MISMA transacción (nunca un AUTHORIZING sin pedido)
   *   ↓
   *   webhook llegará despues → FSM AUTHORIZED/FAILED
   *
   * Si la pasarela no abre el pago:
   *   - pasajero (sin respuesta, 5xx, breaker): el cobro no se toca y el
   *     cliente reintenta de verdad (409 GATEWAY_RETRY);
   *   - definitivo: CHECKOUT_FAILED → FAILED (nunca llegó al banco) y 409
   *     GATEWAY_FAILED (pedir otro cobro).
   * Si el pago ya está en AUTHORIZING o terminal → 409 sin ir a la pasarela.
   * Dos POST a la vez: los dos preparan el pago (sin cobrar nada) y gana el
   * primero en pasar a AUTHORIZING; el otro → 409 y no se guarda nada suyo.
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
    await this.assertVenueStillCharges(payment);
    // Otro POST ya lo abrió (o ya terminó): no se vuelve a la pasarela.
    if (!OPENABLE_STATES.has(payment.status)) throw new ConflictException(PAYMENT_ALREADY_STARTED);

    // Resolver provider activo del venue
    const credential = await this.prisma.asSystem((tx) =>
      tx.gatewayCredential.findFirst({
        where: { tenantId: payment.tenantId, active: true },
        orderBy: { createdAt: 'asc' },
      }),
    );
    if (!credential) {
      // Sin pasarela este cobro no se puede pagar con tarjeta: definitivo.
      return this.checkoutNotOpened(payment.id, new Error('Venue has no active gateway credential'), 'no-active-gateway');
    }

    // 1) La pasarela abre el pago (timeouts y circuit breaker en el adapter).
    //    No cobra: si falla, nada ha llegado al banco.
    let opened: OpenedCheckout;
    try {
      opened = await this.openCheckout(payment, credential.provider, choice);
    } catch (err) {
      return this.checkoutNotOpened(payment.id, err, 'gateway-authorize-error');
    }

    // 2) AUTHORIZING + pasarela, pedido, URL/formulario e intento, todo en la
    //    transacción de la FSM (fila bloqueada). Si otra request ya lo movió,
    //    InvalidTransitionError → 409 y lo de esta se deshace. La petición es
    //    pública (sin local): se hace en el local del cobro, así el middleware
    //    de Prisma filtra por él lo que escribe el prepare.
    try {
      await inVenue(this.cls, payment.tenantId, () =>
        this.transition(payment.id, { type: 'AUTHORIZING' }, payment.tenantId, {
          prepare: async (tx, locked) => {
            if (!OPENABLE_STATES.has(locked.status)) throw new InvalidTransitionError(locked.status, 'AUTHORIZING');
            await this.saveAttempt(tx, payment, credential.provider, opened, choice);
            return { provider: credential.provider, providerTxId: opened.result.providerTxId };
          },
        }),
      );
    } catch (err) {
      if (err instanceof InvalidTransitionError) throw new ConflictException(PAYMENT_ALREADY_STARTED);
      throw err;
    }
    const { providerTxId } = opened.result;

    // 3) Encolar orphan-reconcile (se autocancela si llega webhook antes)
    // Attempts + backoff: si la pasarela devuelve UNKNOWN reintenta 5 veces.
    // Tras agotar, el processor transiciona el pago a ORPHAN (visible en
    // admin para reconciliación manual). Un trabajo anterior de este cobro que
    // agotó los reintentos por un error se quita antes (orphan-enqueue.ts).
    await enqueueOrphanReconcile(
      this.orphanReconcileQueue,
      this.logger,
      { paymentId: payment.id, tenantId: payment.tenantId },
      ORPHAN_RECONCILE_DELAY_MS,
    );

    this.logger.log(
      `Payment ${payment.id} authorizing via ${credential.provider} (txId=${providerTxId})`,
    );
    return { status: 'AUTHORIZING', providerTxId };
  }

  /**
   * Al ir al banco se vuelve a mirar lo que se miró al crear el cobro: el
   * local (o su negocio) en pausa → 423, y la forma de cobro apagada en
   * Ajustes («QR con tarjeta»; la recarga, también «Saldo») → 409. Un QR
   * creado antes no se cobra después, como el cobro con el saldo.
   */
  private async assertVenueStillCharges(payment: { tenantId: string; walletId: string | null }): Promise<void> {
    const venue = await this.prisma.asSystem((tx) =>
      tx.venue.findUnique({ where: { id: payment.tenantId }, select: { ...VENUE_PAUSE_SELECT, ...VENUE_METHODS_SELECT } }),
    );
    assertVenueNotPaused(venue);
    assertMethodsEnabled(venue, methodsNeededForPayment({ isWalletTopUp: payment.walletId !== null, isPosExternal: false }));
  }

  /**
   * La pasarela abre un intento: authorize() prepara la página del banco
   * (no cobra). Sus errores salen como CheckoutNotOpenedError, pasajero o no.
   *
   * Al banco va importe + propina: la que eligió el cliente en la página de
   * pago o, sin página (endpoint antiguo), la que ya tuviera el cobro.
   */
  private async openCheckout(
    payment: { id: string; tenantId: string; amountCents: number; tipCents: number; currency: string },
    provider: Provider,
    choice?: CheckoutChoice,
  ): Promise<OpenedCheckout> {
    // Solo Redsys cobra y reparte la propina (la del aprobado pasa al cobro
    // en transition). Las demás pasarelas cobran el importe, como antes.
    const tipCents = provider === 'REDSYS' ? (choice?.tipCents ?? payment.tipCents) : null;
    const chargeCents = payment.amountCents + (tipCents ?? 0);
    try {
      const result = await this.gateways.get(provider).authorize({
        tenantId: payment.tenantId,
        paymentId: payment.id,
        amountCents: chargeCents,
        currency: payment.currency,
        terminalExternalId: '',
        reference: payment.id,
        ...(provider === 'REDSYS' && choice?.method ? { payMethod: choice.method } : {}),
        ...(choice ? { language: choice.language } : {}),
      });
      return { result, chargeCents, tipCents };
    } catch (err) {
      throw new CheckoutNotOpenedError(err);
    }
  }

  /**
   * Guarda el intento abierto: pasarela, providerTxId y URL/form del checkout
   * en el cobro, y la fila de payment_attempts. Cada intento es un pedido
   * distinto, y el aviso del banco se resuelve por cualquiera de ellos.
   */
  private async saveAttempt(
    tx: TransactionalClient,
    payment: { id: string; tenantId: string },
    provider: Provider,
    opened: OpenedCheckout,
    choice?: CheckoutChoice,
  ): Promise<void> {
    const { result, chargeCents, tipCents } = opened;
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        provider,
        providerTxId: result.providerTxId,
        ...(result.paymentLinkUrl ? { gatewayPaymentUrl: result.paymentLinkUrl } : {}),
        ...(result.checkoutForm ? { gatewayCheckoutForm: result.checkoutForm } : {}),
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
        claimHash: choice?.claimHash ?? null,
      },
    });
  }

  /**
   * La pasarela no abrió el primer pago (nada llegó al banco). El detalle va
   * al log: el error puede llevar lo que se le mandó (sent:/branchesRaw: de
   * Paytef) y esto es público.
   *  - pasajero: el cobro no se toca (sigue CREATED/AWAITING_CAPTURE) y el
   *    «Intentar otra vez» abre el pago de verdad;
   *  - definitivo: CHECKOUT_FAILED → FAILED, y el cliente pide otro cobro.
   *    Si otra petición lo abrió mientras tanto (AUTHORIZING), ese sigue.
   */
  private async checkoutNotOpened(paymentId: string, err: unknown, reason: string): Promise<never> {
    this.logger.error(`Gateway authorize failed for ${paymentId}: ${(err as Error)?.message || 'unknown'}`);
    if (err instanceof CheckoutNotOpenedError && err.transient) throw gatewayRetry();
    try {
      await this.transition(paymentId, { type: 'CHECKOUT_FAILED', reason });
    } catch (e2) {
      if (!(e2 instanceof InvalidTransitionError)) throw e2;
      if (e2.fromState !== 'FAILED') throw new ConflictException(PAYMENT_ALREADY_STARTED);
    }
    throw gatewayFailed();
  }

  /**
   * Reverse proporcional de la parte de la chica — comisión Y propina — cuando
   * hay refund (parcial o total): ver expectedChicaReversal (refund-share.ts).
   * Llamado por RefundsService después de que el refund llega a SUCCEEDED.
   *
   * Idempotencia: tabla earning_reversals(refundId UNIQUE). Si el processor
   * reintenta con el mismo refundId, no duplicamos el descuento.
   *
   * Accumulator pattern: en lugar de sumar `floor(refundN * bps / 10000)` por
   * cada refund (que acumula dust), calculamos el reversedTotal ESPERADO en
   * función del cumulativo refundeado hasta el momento, y aplicamos el delta:
   *
   *   expectedTotalReversed = round((comisión + propina) * devuelto / cobrado)
   *   delta = expectedTotalReversed - currentReversedCents
   *
   * Esto garantiza el invariante: si todos los refunds suman lo cobrado
   * (servicio + propina), lo descontado iguala exactamente su parte — sin dust.
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
    // asSystem: operator_earnings tiene RLS forzado (con un usuario de BD sin
    // superusuario, una transacción normal no ve la ganancia).
    await this.prisma.asSystem(async (tx) => {
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
          tipCents: number;
          reversedCents: number;
          chargedCents: number;
          payoutId: string | null;
        }>
      >`
        SELECT e.id, e."tenantId", e."commissionBps", e."commissionCents", e."tipCents",
               e."reversedCents", (p."amountCents" + p."tipCents") AS "chargedCents", e."payoutId"
          FROM operator_earnings e
          JOIN payments p ON p.id = e."paymentId"
         WHERE e."paymentId" = ${paymentId}::uuid
         ORDER BY e.id
         FOR UPDATE OF e
      `;
      if (earning.length === 0) {
        this.logger.log(
          `applyRefundToEarning: no earning for payment=${paymentId} (creator not OPERATOR)`,
        );
        return;
      }

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

      // Una devolución descuenta a cada persona con ganancia en el cobro (la
      // chica que cobró o la invitada y, si le tocó algo, el camarero), cada
      // una en la misma proporción. Un cobro de una sola ganancia, como siempre.
      for (const e of earning) {
        const totalCumulative = Math.min(priorCumulative + refundAmountCents, e.chargedCents);

        // 3. Reversed total esperado tras este refund (comisión + propina). Las
        //    reversiones que llegan con el earning ya pagado no tocan
        //    reversedCents (eso refleja lo que se le pagó); se suman aparte como deuda.
        const expectedTotalReversed = expectedChicaReversal({
          commissionCents: e.commissionCents,
          tipCents: e.tipCents,
          chargedCents: e.chargedCents,
          refundedCents: totalCumulative,
        });
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
          ON CONFLICT ("refundId", "earningId") DO NOTHING
        `;

        this.logger.log(
          `Earning reversal payment=${paymentId} refundId=${refundId} earning=${e.id} delta=${reverseDelta} expected=${expectedTotalReversed} bps=${e.commissionBps} tip=${e.tipCents} cumulative=${totalCumulative}/${e.chargedCents}`,
        );
      }
    });
  }

  // ─── helpers ───────────────────────────────────────────────────────

  private async toCreatedResponse(paymentId: string): Promise<CreatedPaymentResponse> {
    // CLS ya tiene tenantId del request (AuthGuard lo seteo). El middleware de
    // Prisma inyecta WHERE tenantId — y como el pago lo acabamos de crear con
    // ese mismo tenant, la query devuelve el registro correcto. asSystem: sin
    // depender de un usuario de base superusuario (FORCE RLS en payments).
    const { p, lines } = await this.prisma.asSystem(async (tx) => ({
      // Cobro único: con el cobro del saldo enlazado (si se pidió y el local lo tiene).
      p: await tx.payment.findUniqueOrThrow({
        where: { id: paymentId },
        include: { linkedWalletCharge: { select: { id: true, expiresAt: true } } },
      }),
      lines: await linesOf(tx, { paymentIds: [paymentId] }),
    }));
    const saldo = p.linkedWalletCharge ?? null;
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
      ref: formatChargeRef(p.ref),
      lines: lineViews(lines),
      // Recarga de saldo: el id de la wallet. Su enlace (la credencial del
      // cliente para aceptar cobros) no se da nunca al personal.
      walletId: p.walletId ?? null,
      // Cobro único: el NFC y el PIN pagan este cobro del saldo (su enlace
      // /s/… no hace falta aquí: lo ofrece la página de pago del QR).
      saldo: saldo ? { chargeId: saldo.id, expiresAt: saldo.expiresAt.toISOString() } : null,
    };
  }
}
