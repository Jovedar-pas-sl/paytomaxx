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
import { insertPaymentEvent, recordPaymentDevice, WALLET_CREDITED_EVENT } from './payment-device';
import { paidMethodOf } from './paid-method';
import {
  chargeBreakdownText,
  chargeRightsOf,
  formatChargeRef,
  formatMoney,
  methodsNeededForPayment,
  postRulesOf,
  paymentMethodsOf,
  type BitcoinPayState,
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
import { VENUE_METHODS_SELECT, assertMethodsEnabled } from '../venues/venue-methods';
import { isPartyEdition } from '../../config/edition';
import { assertEventOpen } from '../party/event-window';
import { stallIdForStaff, stallSeal } from '../party/stall-seal';
import { resolveBpsForOperator, type OperatorCommissionDefaults, type RevenueCategory } from './commission';
import { lineCommission, lineViews, type DraftLine } from './charge-lines';
import { linesWithOperatorBps, resolveChargeOrThrow, type LineWithBps } from './charge-request';
import { assignChargeRef, insertChargeLines, insertInvitationEarnings, linesOf, servedOperators } from './charge-store';
import { invitationEarnings } from './invitation-lines';
import { cardQrUrl } from './pay-qr-url';
import { assertCanTopUp } from '../venues/charge-rights';
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
  staffTipRemoved,
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
import { isGiftPaymentKey, isHomeTopUpKey } from '../home-topup/home-topup-rules';
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
import { applyReservationPayment } from '../reservations/reservation-ledger';
import { isReservationPaymentKey } from '../reservations/reservation-payment-key';
import { sweepUnpaidTopUpWallet } from './topup-wallet-sweep';
import { PAID_WITH_SALDO_EVENT, closeLinkedSaldo } from './cobro-link';
import { wasPaidAfterCancel } from './paid-after-cancel';
import { RESULT_PAGE_PROVIDERS } from './pay-status.service';
import { assertBankWaitOver } from './cancel-at-bank';
import { heldOnReaderConflict, isHeldOnReader } from './reader-hold';
import { serviceFeeQuote } from '@nightpay/contracts';
import { btcpayEnabled } from '../btcpay/btcpay-flag';
import { bitcoinOfferedFor } from '../btcpay/btcpay-logic';
import { VENUE_SERVICE_FEE_SELECT, refundableFeeCents, venueServiceFeeOf } from './service-fee';

const POS_AUTH_CODE_REUSED =
  'Ese código de autorización ya se usó en otro cobro de este datáfono. Revisa el ticket.';
/**
 * Confirmar un cobro del datáfono pasado su plazo (30 min). Normalmente ya lo
 * ha caducado su trabajo; si ese trabajo no llegó a correr, tampoco se da por
 * pagado (antes sí, con el código que se tecleara y la hora de ahora).
 */
export const POS_PAYMENT_EXPIRED =
  'Este cobro ha caducado y ya no se puede confirmar: hay que crear otro cobro. Si ya pasaste la tarjeta, avisa al encargado.';
/** `code` de ese 409 (las apps lo distinguen sin leer el texto). */
export const POS_PAYMENT_EXPIRED_CODE = 'POS_PAYMENT_EXPIRED';
/** Confirmar un cobro del datáfono por otro importe que su total (con la «Comisión del servicio»). */
export const POS_CHARGE_MISMATCH_CODE = 'POS_CHARGE_MISMATCH';

/**
 * Un cobro del datáfono con «Comisión del servicio» se confirma con lo que se
 * cobró (`chargedCents`): una app de antes, que enseña el importe sin ella, no
 * lo manda y no puede confirmarlo (si no, se apuntaría una comisión que nadie
 * cobró). Sin comisión, como siempre (si lo manda, el importe).
 */
function posChargeProblem(
  payment: { amountCents: number; serviceFeeCents?: number | null },
  chargedCents: number | undefined,
): ConflictException | null {
  const fee = Math.max(0, payment.serviceFeeCents ?? 0);
  const expected = payment.amountCents + fee;
  const total = formatMoney(expected);
  const detail = fee > 0 ? ` (${chargeBreakdownText({ baseCents: payment.amountCents, feeCents: fee, tipCents: 0 })})` : '';
  if (chargedCents === undefined) {
    if (fee === 0) return null;
    return new ConflictException({
      message: `Esta pantalla no enseña la comisión del servicio: el cobro es de ${total}${detail}. Recarga la app, comprueba lo cobrado en el datáfono y vuelve a confirmar.`,
      code: 'SERVICE_FEE_APP_OUTDATED',
      chargedCents: expected,
    });
  }
  if (chargedCents === expected) return null;
  return new ConflictException({
    message: `El cobro es de ${total}${detail} y se ha confirmado ${formatMoney(chargedCents)}: cobra la diferencia o anula la operación en el datáfono y vuelve a confirmar.`,
    code: POS_CHARGE_MISMATCH_CODE,
    chargedCents: expected,
  });
}
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
  /** Id del intento (al azar): la pasarela lo lleva como referencia nuestra (Paytef, Cecabank). */
  attemptId: string;
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
  /** % antiguo de OxioPay fijado al crear: 0 con la «Comisión del servicio» encendida. */
  platformCommissionBps: number;
  /**
   * «Comisión del servicio» del momento (service-fee.ts): el % (null = sin
   * comisión, interruptor apagado) y el importe, encima de amountCents.
   */
  serviceFee: { bps: number | null; cents: number };
  /** % de la chica fijado al crear (#54); null si no lo crea una chica. */
  operatorCommissionBps: number | null;
  /** Cobro único: también se puede pagar con el saldo (cobro del saldo enlazado; su propina la elige el cliente al pagar). */
  withSaldo: boolean;
  /** OxioParty: la caseta de quien cobra (también la del cobro del saldo enlazado). Null en OxioPay y en las recargas. */
  stallId: string | null;
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
 * La que creó el saldo desde el enlace del local («Cargar saldo antes de
 * llegar», Idempotency-Key `wcasa:`) lo da igual al navegador que la pagó y,
 * además, lo manda a la página de ese saldo con la bienvenida (walletFromHome).
 */
export function payerWalletFields(args: {
  wallet: PayerWalletRow | null;
  firstTopUp: boolean;
  idempotencyKey: string | null | undefined;
  approvedClaimHash: string | null;
}): Pick<
  PayablePayment,
  'walletToken' | 'walletClaimHash' | 'walletCode' | 'walletHasFaceId' | 'walletHasPin' | 'walletReturnToken' | 'walletFromHome'
> {
  const returnClaimHash = args.wallet ? selfTopUpClaimHash(args.idempotencyKey) : null;
  // Reservados: el saldo del grupo no se enseña a quien paga (la señal es saldo al llegar).
  // Regalos: quien regala nunca tiene el saldo (ni su enlace, ni su código, ni su Face ID o PIN).
  const hidden = isReservationPaymentKey(args.idempotencyKey) || isGiftPaymentKey(args.idempotencyKey);
  const wallet = args.wallet && args.firstTopUp && !returnClaimHash && !hidden ? args.wallet : null;
  return {
    walletToken: wallet?.qrToken ?? null,
    walletClaimHash: returnClaimHash ?? (wallet ? args.approvedClaimHash : null),
    walletCode: wallet?.shortCode ? formatWalletCode(wallet.shortCode) : null,
    walletHasFaceId: (wallet?._count.passkeys ?? 0) > 0,
    walletHasPin: Boolean(wallet?.pinHash),
    ...(returnClaimHash && args.wallet ? { walletReturnToken: args.wallet.qrToken } : {}),
    ...(wallet && isHomeTopUpKey(args.idempotencyKey) ? { walletFromHome: true } : {}),
  };
}

/** Choque con la Idempotency-Key de otro cobro creado a la vez (P2002). */
function isIdempotencyKeyClash(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  return JSON.stringify(err.meta?.target ?? '').includes('idempotencyKey');
}

/** El código del 409 al cancelar con el bitcoin ya en la red (la app del personal lo explica). */
export const BITCOIN_CONFIRMING_CODE = 'BITCOIN_CONFIRMING';

/**
 * Cancelar un cobro con su factura de bitcoin «Processing» (el pago ya está en
 * la red y falta su confirmación): no, el dinero llegaría igual. Dentro de
 * transition(), con el cobro bloqueado.
 */
async function assertBitcoinNotOnTheWay(tx: TransactionalClient, paymentId: string): Promise<void> {
  const onTheWay = await tx.$queryRaw<Array<{ one: number }>>`
    SELECT 1 AS one FROM btcpay_invoices WHERE "paymentId" = ${paymentId}::uuid AND status = 'Processing' LIMIT 1
  `;
  if (onTheWay.length === 0) return;
  throw new ConflictException({
    code: BITCOIN_CONFIRMING_CODE,
    message: 'El cliente ya ha pagado con bitcoin y falta la confirmación de la red: no se puede cancelar. Espera unos minutos.',
  });
}

/** Fila del cobro bloqueada (FOR UPDATE) dentro de transition(). */
export interface LockedPaymentRow {
  id: string;
  tenantId: string;
  status: PaymentMachineState;
  amountCents: number;
  availableAmountCents: number;
  providerTxId: string | null;
  provider: 'WIPAY' | 'PEANPE' | 'PAYTEF' | 'REDSYS' | 'BTCPAY' | null;
  createdByUserId: string | null;
  walletId: string | null;
  tipCents: number;
  tipGoesTo: string | null;
  tipBeneficiaryUserId: string | null;
  revenueCategory: string;
  /** % de la chica fijado al crear el cobro (null en cobros anteriores). */
  operatorCommissionBps?: number | null;
  /** «Comisión del servicio» fijada al crear (0 sin ella o en cobros anteriores). */
  serviceFeeCents?: number;
  /** Operación del datáfono (PAX): con AUTHORIZING, recarga cobrada sin comprobar (reader-hold.ts). */
  posOperationNumber?: string | null;
}

/**
 * Lo que mira «Cancelar cobro» antes de cancelar (con el cobro bloqueado; o,
 * para avisar antes, leído sin bloquear): la recarga cobrada en el datáfono sin
 * comprobar, nunca (409 CANCEL_HELD_ON_READER); con el bitcoin ya en la red, no
 * (409 BITCOIN_CONFIRMING); con el cliente en su banco, no antes de 2 minutos
 * (409 CANCEL_AT_BANK_TOO_SOON).
 */
async function assertCancelable(
  tx: TransactionalClient,
  p: Pick<LockedPaymentRow, 'id' | 'tenantId' | 'status' | 'provider' | 'posOperationNumber'>,
): Promise<void> {
  if (isHeldOnReader(p)) throw heldOnReaderConflict();
  if (p.status === 'AUTHORIZING' && p.provider === 'BTCPAY') await assertBitcoinNotOnTheWay(tx, p.id);
  // Con el cliente en su banco, no antes de 2 minutos (con el cobro bloqueado: la marca no cambia mientras).
  await assertBankWaitOver(tx, p);
}

/**
 * El pago a medias de un reservado que se cancela al anular la reserva o al
 * elegir otro pago: sin empezar o con su factura de bitcoin abierta. Con la
 * tarjeta ya en el banco, no (lo resuelve el banco); pagado o cerrado, tampoco.
 */
export function reservationPaymentCancelable(p: { status: string; provider: string | null }): boolean {
  return p.status === 'CREATED' || p.status === 'AWAITING_CAPTURE' || (p.status === 'AUTHORIZING' && p.provider === 'BTCPAY');
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
/** Cancelados con pedido en el banco que el repaso de cada 10 min vuelve a mirar: los de esta última media hora. */
const CANCELED_RECHECK_WINDOW_MS = 30 * 60 * 1000;
/** Como mucho tantos por repaso y tipo (el resto, en el siguiente). */
const BANK_RECHECK_LIMIT = 50;
/** Para leer por el índice de qrExpiresAt: un cobro de las últimas horas (su plazo es de 5 a 30 min). */
const BANK_RECHECK_LOOKBACK_MS = 6 * 60 * 60 * 1000;

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
      // Bitcoin no: su factura la vigila el repaso de BTCPay (btcpay-sweep). La
      // conciliación de las pasarelas no sabe preguntar a BTCPay y, agotada, lo
      // dejaba «Sin confirmar» (ORPHAN) mientras el cliente aún podía pagar.
      const stuck = await this.prisma.$queryRawUnsafe<Array<{
        id: string;
        tenantId: string;
      }>>(
        `SELECT id::text, "tenantId"::text
         FROM payments
         WHERE status = 'AUTHORIZING'
           AND provider IS NOT NULL
           AND provider::text <> 'BTCPAY'
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
   * Lo llama el repaso de cada 10 min (QrExpireSweepService): vuelve a pedir
   * la comprobación al banco (orphan-reconcile) de los cobros cancelados en
   * la última media hora con un pedido abierto en el banco: el cliente pudo
   * pagar en su banco después y perderse el aviso («Pagó después de
   * cancelar»). Con tope; un trabajo ya en cola de ese cobro no se repite.
   */
  async requeueBankChecks(now: Date = new Date()): Promise<{ canceled: number }> {
    const canceled = await this.prisma.asSystem((tx) => tx.$queryRaw<Array<{ id: string; tenantId: string }>>`
      SELECT id::text, "tenantId"::text
        FROM payments
       WHERE status = 'CANCELED'
         AND provider IS NOT NULL
         AND provider::text <> 'BTCPAY'
         AND "providerTxId" IS NOT NULL
         AND "qrExpiresAt" >= ${new Date(now.getTime() - BANK_RECHECK_LOOKBACK_MS)}
         AND "updatedAt" >= ${new Date(now.getTime() - CANCELED_RECHECK_WINDOW_MS)}
       ORDER BY "updatedAt" DESC
       LIMIT ${BANK_RECHECK_LIMIT}
    `);
    for (const p of canceled) {
      await enqueueOrphanReconcile(this.orphanReconcileQueue, this.logger, { paymentId: p.id, tenantId: p.tenantId }, 1000);
    }
    return { canceled: canceled.length };
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
      amountCents: payment.amountCents + payment.serviceFeeCents,
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
          ...VENUE_SERVICE_FEE_SELECT,
        },
      }),
    );
    // Local (o su negocio) en pausa: ni cobros ni recargas nuevos (423 VENUE_PAUSED).
    assertVenueNotPaused(venue);
    // OxioParty: con la fiesta terminada, tampoco (423 EVENT_ENDED); y la
    // caseta de quien cobra. OxioPay: no se mira nada.
    const stallId = await this.partyDraft(tenantId, creator.userId, isWalletTopUp);
    // Forma de cobro apagada en Ajustes (QR con tarjeta, datáfono; la recarga
    // también necesita el saldo): 409 PAYMENT_METHOD_DISABLED.
    const methods = assertMethodsEnabled(venue, methodsNeededForPayment({ isWalletTopUp, isPosExternal: byDatafono }));
    // Las recargas del saldo, solo en recepción (el puesto), el encargado, el
    // dueño o el datáfono de recepción. El cliente desde /w no tiene persona.
    if (isWalletTopUp && !viaDevice && creator.userId) await this.assertCanTopUp(tenantId, creator.userId, creatorRole);
    const { amountCents, service, revenueCategory, lines, typedCents } = await this.resolveCharge(tenantId, dto, creator);

    // B1: la propina solo la pone el cliente al pagar (con tarjeta, en la
    // página de pago; por datáfono, la del datáfono). Quien crea el cobro ya
    // no la pone: una app de antes que la mande recibe un 400 claro.
    if ((dto.tipCents ?? 0) > 0) throw staffTipRemoved();
    const creatorTip = await this.resolveCreatorTip({ tenantId, dto, amountCents, creatorRole, isPosExternal, isWalletTopUp });
    // A nombre de una compañera: la propina que deje el cliente (tarjeta o datáfono) es entera suya.
    const tip = lines.some((l) => l.serviceOperatorId) ? { ...creatorTip, tipGoesTo: 'operator' } : creatorTip;
    const capProblem = operatorCapProblem({
      creatorRole,
      isWalletTopUp,
      typedCents,
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
    // «Comisión del servicio» (interruptor del local): el pago directo con
    // tarjeta o datáfono, al % de las tarjetas; la recarga, al de las recargas.
    // Encendida, el local ya no paga el % antiguo de OxioPay sobre este cobro.
    const fee = serviceFeeQuote(venueServiceFeeOf(venue), isWalletTopUp ? 'topUp' : 'card', amountCents);
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
      platformCommissionBps: fee.bps === null ? venue.platformCommissionBps : 0,
      serviceFee: { bps: fee.bps, cents: fee.feeCents },
      operatorCommissionBps: commission.paymentBps,
      // Cobro único: con el saldo encendido en el local y quien cobra con
      // nombre (el cobro del saldo es suyo). Ni recargas ni datáfono.
      withSaldo: Boolean(dto.withSaldo) && !isWalletTopUp && !byDatafono && methods.wallet && creator.userId !== null,
      stallId,
    };
  }

  /**
   * OxioParty (EDITION=party): la fiesta no ha terminado (si no, 423
   * EVENT_ENDED: ni cobros ni recargas nuevos) y la caseta de quien cobra,
   * para sellarla en el cobro. Una recarga no es venta de ninguna caseta: sin
   * caseta (el consumo del saldo ya llevará la suya). OxioPay: null sin mirar
   * la base.
   */
  private async partyDraft(tenantId: string, creatorUserId: string | null, isWalletTopUp: boolean): Promise<string | null> {
    if (!isPartyEdition()) return null;
    return this.prisma.asSystem(async (tx) => {
      await assertEventOpen(tx, tenantId);
      return isWalletTopUp ? null : stallIdForStaff(tx, { tenantId, userId: creatorUserId });
    });
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
    // A nombre de una compañera (cobro por el encargado): cada línea ya trae su % (serviceOperatorOf).
    if (args.lines.some((l) => l.serviceOperatorId)) {
      const lines = args.lines.map((l) => ({ ...l, operatorCommissionBps: l.operatorCommissionBps ?? 0 }));
      const paymentBps = lineCommission(lines.map((l) => ({ amountCents: l.amountCents, bps: l.operatorCommissionBps }))).commissionBps;
      return { lines, paymentBps };
    }
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
   *  - Sin ninguno: el único terminal activo del local; con varios, 400 (no se elige por nadie).
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
      const active = await this.prisma.asSystem((tx) =>
        tx.terminal.findMany({ where: { tenantId, active: true }, select: { id: true }, take: 2 }),
      );
      if (active.length === 1) return active[0]!.id;
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
    typedCents: number;
    rights: ChargeRights | null;
  }> {
    if (dto.wallet) {
      if (!dto.amountCents) throw new BadRequestException('Pon el importe');
      return { amountCents: dto.amountCents, service: null, revenueCategory: 'EXTRA', lines: [], typedCents: dto.amountCents, rights: null };
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
      serviceStaffToken: dto.serviceStaffToken,
    });
    const service: ServiceSnapshot | null =
      charge.service ?? (charge.serviceName ? { serviceItemId: null, serviceName: charge.serviceName, durationMin: null } : null);
    return {
      amountCents: charge.amountCents,
      service,
      revenueCategory: charge.primaryCategory,
      lines: charge.lines,
      typedCents: charge.typedCents,
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
    const feeCents = draft.serviceFee.cents;
    // La comisión de un pago directo se devuelve con él; la de una recarga, no.
    const refundableFee = draft.topUp ? 0 : feeCents;
    return this.prisma.asSystem(async (tx) => {
      const walletId = await this.topUpWalletId(tx, tenantId, draft.topUp);
      const p = await tx.payment.create({
        data: {
          tenantId,
          terminalId: draft.terminalId,
          createdByUserId: input.creatorUserId,
          idempotencyKey: input.idempotencyKey,
          idempotencyHash: input.requestHash,
          amountCents: draft.amountCents,
          // availableAmountCents incluye tip (y la comisión del servicio de un
          // pago directo) — refunds pueden cubrir todo lo cobrado.
          availableAmountCents: draft.amountCents + refundableFee + tipCents,
          serviceFeeBps: draft.serviceFee.bps,
          serviceFeeCents: feeCents,
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
          // OxioParty: la caseta de quien cobra (en OxioPay no se añade nada).
          ...stallSeal(draft.stallId),
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
                expiresAt: qrExpiresAt,
                linkedPaymentId: p.id,
                ...stallSeal(draft.stallId),
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
            ...(feeCents > 0 ? { serviceFeeCents: feeCents, serviceFeeBps: draft.serviceFee.bps } : {}),
            ...(ignoredCents > 0 ? { tipIgnoredCents: ignoredCents } : {}),
            terminal: dto.terminalExternalId,
            walletId,
            ...(saldo ? { saldoChargeId: saldo.id } : {}),
          },
          traceId: this.cls.get('ctx')?.traceId ?? randomUUID(),
        },
      });
      // Detalle del pago: con qué móvil se creó (el del personal; el del
      // cliente en una recarga desde /w o desde casa; el datáfono).
      await recordPaymentDevice(tx, this.cls.get('ctx'), { id: p.id, tenantId }, 'create', saldo ? { walletChargeId: saldo.id } : {});
      // Referencia corta (C-0001), la misma en los dos: lo último, el contador del local bloqueado solo hasta el commit.
      await assignChargeRef(tx, tenantId, { paymentId: p.id, walletChargeId: saldo?.id ?? null });
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
  /**
   * «Pagar con bitcoin» en la página de pago: solo al cargar saldo y en los
   * reservados (bitcoinOfferedFor: los dos llevan su saldo), nunca en un cobro de
   * la barra; con el servidor encendido (BTCPAY_ENABLED) y el local en Ajustes.
   * Apagado el servidor, o en un cobro de la barra, ni se mira la base.
   */
  private async bitcoinOffered(tenantId: string, payment: { walletId: string | null }): Promise<boolean> {
    if (!btcpayEnabled() || !bitcoinOfferedFor(payment)) return false;
    const store = await this.prisma.asSystem((tx) => tx.btcpayStore.findUnique({ where: { tenantId }, select: { enabled: true } }));
    return Boolean(store?.enabled);
  }

  /** Cosas que hacer cuando se cancela un cobro (BTCPay: cerrar su factura). Las registra quien las necesita. */
  private readonly cancelHooks: Array<(paymentId: string, tenantId: string) => Promise<void>> = [];
  registerCancelHook(hook: (paymentId: string, tenantId: string) => Promise<void>): void {
    this.cancelHooks.push(hook);
  }

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
    if (payment.status !== 'AUTHORIZING') return this.withStaffPhoto(choosePayPage(payment), payment.staffUserId);
    // Factura de bitcoin abierta: su página (QR y cuenta atrás), no la del banco.
    if (payment.provider === 'BTCPAY') return { kind: 'bitcoin' };
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
    return decision === 'retry' ? this.withStaffPhoto(choosePayPage(payment), payment.staffUserId) : retryOutcome(decision);
  }

  /**
   * La foto de quien cobra en la página de pago (va dentro, como data:, por la
   * CSP y la mala red). Solo aquí: el POST no la necesita. Si no se puede
   * leer, la página sale igual, con su nombre.
   */
  private async withStaffPhoto(view: PayRedirect, userId: string | null): Promise<PayRedirect> {
    if (view.kind !== 'choose' || !view.staffName || !userId) return view;
    try {
      const photo = await this.prisma.asSystem((tx) =>
        tx.userPhoto.findUnique({ where: { userId }, select: { contentType: true, data: true } }),
      );
      if (!photo) return view;
      const type = photo.contentType === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
      return { ...view, staffPhoto: `data:${type};base64,${Buffer.from(photo.data).toString('base64')}` };
    } catch (err) {
      this.logger.warn(`Foto de quien cobra sin leer (user=${userId}): ${(err as Error).message}`);
      return view;
    }
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
      let opened: Awaited<ReturnType<PaymentsService['startAuthorization']>>;
      try {
        opened = await this.startAuthorization(qrToken, choice);
      } catch (err) {
        // Doble toque: el otro POST (de este navegador) ya abrió el pedido → mismo formulario.
        const order = await this.freshOrderOf(payment.id, choice.claimHash ?? null);
        if (!order) throw err;
        return { kind: 'checkout', order };
      }
      // Con el pedido abierto, sin volver a la base: si ahora no hay conexión
      // libre, el cobro quedaba «esperando al banco» sin que el formulario
      // llegara al cliente (carga del 19-11-2026).
      const { providerTxId, result } = opened;
      if (result?.checkoutForm && providerTxId) return { kind: 'checkout', order: providerTxId };
      if (result?.paymentLinkUrl) return { kind: 'redirect', url: result.paymentLinkUrl, status: 'AUTHORIZING' };
      const view = await this.checkoutOf(payment.id);
      return view.kind === 'form' && providerTxId ? { kind: 'checkout', order: providerTxId } : view;
    }
    if (payment.provider === 'BTCPAY') return { kind: 'bitcoin' };
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
  ): Promise<
    PayablePayment & { tenantId: string; provider: Provider | null; updatedAt: Date; walletId: string | null; staffUserId: string | null }
  > {
    const payment = await this.prisma.asSystem((tx) =>
      tx.payment.findUnique({
        where: { qrToken },
        select: {
          id: true,
          tenantId: true,
          status: true,
          provider: true,
          amountCents: true,
          serviceFeeCents: true,
          serviceFeeBps: true,
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
          // Quién cobra: su nombre visible (nunca el correo) para la página de pago.
          createdByUserId: true,
          createdBy: { select: { role: true, post: true, displayName: true } },
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
    // (Una factura de bitcoin cerrada deja el cobro con BTCPAY: para la tarjeta cuenta la pasarela del local.)
    const provider = payment.provider && payment.provider !== 'BTCPAY' ? payment.provider : await this.activeProvider(payment.tenantId);
    const { walletId, wallet, attempts, venue, createdBy, serviceName, tipGoesTo, idempotencyKey, linkedWalletCharge, ...rest } =
      payment;
    const firstTopUp = wallet !== null && !selfTopUpClaimHash(idempotencyKey) && (await this.isFirstTopUp(walletId, payment.id));
    // Propinas del local (Ajustes → Formas de cobro): apagadas, no se ofrecen ni se aceptan.
    const methods = paymentMethodsOf(venue?.paymentMethods);
    // Y el puesto de quien cobra (recepción no lleva propinas). A nombre de una
    // compañera (cobro por el encargado), el de ella: la fila Sala. Una recarga nunca lleva compañera.
    const rules = postRulesOf(venue?.postRules);
    const served =
      walletId === null && createdBy && createdBy.role !== 'OPERATOR'
        ? (await this.prisma.asSystem((tx) => servedOperators(tx, { paymentIds: [payment.id] }))).get(payment.id)
        : undefined;
    const creatorTips = served ? rules.SALA.tips : createdBy ? chargeRightsOf(createdBy, rules).tips : true;
    // Bitcoin: al cargar saldo y en los reservados (la señal, el resto o todo); en un cobro de la barra, nunca.
    const bitcoin = await this.bitcoinOffered(payment.tenantId, { walletId });
    // Cancelado por el personal y cobrado después por el banco: el cliente no ve «cancelado» a secas.
    const paidAfterCancel = payment.status === 'CANCELED' && (await this.prisma.asSystem((tx) => wasPaidAfterCancel(tx, payment.id)));
    return {
      ...rest,
      ...(bitcoin ? { bitcoin: true } : {}),
      ...(paidAfterCancel ? { paidAfterCancel: true } : {}),
      walletId,
      topUp: Boolean(walletId),
      status: payment.status as PaymentMachineState,
      allowTip: provider === 'REDSYS' && walletId === null && methods.tips && creatorTips,
      tipPresets: { flatCents: methods.tipFlatCents, percents: methods.tipPercents },
      venueName: venue?.name ?? null,
      concept: serviceName ?? null,
      tipToStaff: tipGoesToStaff({ tipGoesTo: tipGoesTo ?? null, creatorRole: createdBy?.role ?? null, served: Boolean(served) }),
      // A nombre de una compañera, ella (su nombre y su foto): «Servicio con Nerea».
      staffName: served ? served.name : createdBy?.displayName?.trim() || null,
      staffUserId: served?.id ?? payment.createdByUserId,
      ...(served ? { served: true } : {}),
      approvedClaimHash: attempts[0]?.claimHash ?? null,
      ...payerWalletFields({ wallet, firstTopUp, idempotencyKey, approvedClaimHash: attempts[0]?.claimHash ?? null }),
      // Reservados: al pagarse (también con bitcoin), el navegador que pagó vuelve a la página del reservado.
      ...(isReservationPaymentKey(idempotencyKey) ? { reservation: true as const } : {}),
      // Regalos: al pagarse, el navegador que pagó va a «Comparte tu regalo» (giftToken).
      ...(isGiftPaymentKey(idempotencyKey) ? { gift: true as const } : {}),
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
  async getResultView(providerTxId: string, opts: { bankApproved?: boolean } = {}): Promise<PayResultView | null> {
    if (!providerTxId) return null;
    const found = await this.prisma.asSystem(async (tx) => {
      // Con la pasarela va por el índice único (provider, providerTxId); sin ella recorre la tabla entera.
      const attempt = await tx.paymentAttempt.findFirst({
        where: { provider: { in: [...RESULT_PAGE_PROVIDERS] }, providerTxId },
        select: { paymentId: true },
      });
      const payment = await tx.payment.findFirst({
        where: attempt ? { id: attempt.paymentId } : { providerTxId },
        select: {
          id: true,
          status: true,
          amountCents: true,
          serviceFeeCents: true,
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
      // Cancelado por el personal y cobrado por el banco: ya apuntado (el aviso llegó) o lo
      // dice la vuelta firmada del banco (el aviso aún está en la cola). Lo del saldo, no.
      const paidAfterCancel =
        payment.status === 'CANCELED' &&
        ((await wasPaidAfterCancel(tx, payment.id)) ||
          (opts.bankApproved === true && (await tx.paymentEvent.count({ where: { paymentId: payment.id, eventType: PAID_WITH_SALDO_EVENT } })) === 0));
      return { payment, attemptStatus: thisAttempt?.status ?? null, paidAfterCancel };
    });
    if (!found) return null;
    const { payment, attemptStatus, paidAfterCancel } = found;
    return {
      paymentId: payment.id,
      ...(paidAfterCancel ? { paidAfterCancel: true } : {}),
      status: payment.status as PaymentMachineState,
      amountCents: payment.amountCents,
      tipCents: payment.tipCents,
      serviceFeeCents: payment.serviceFeeCents,
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
      ...(isReservationPaymentKey(payment.idempotencyKey) ? { reservation: true as const } : {}),
      ...(isGiftPaymentKey(payment.idempotencyKey) ? { gift: true as const } : {}),
    };
  }

  /** Regalos: el enlace del regalo de este pago (para «Comparte tu regalo» después de pagar). */
  async giftToken(paymentId: string): Promise<string | null> {
    const row = await this.prisma.asSystem((tx) => tx.walletGift.findUnique({ where: { paymentId }, select: { token: true } }));
    return row?.token ?? null;
  }

  /** Reservados: el enlace de la reserva de este pago (para volver a ella después de pagar). */
  async reservationManageToken(paymentId: string): Promise<string | null> {
    const row = await this.prisma.asSystem((tx) =>
      tx.reservationPayment.findUnique({ where: { paymentId }, select: { reservation: { select: { manageToken: true } } } }),
    );
    return row?.reservation.manageToken ?? null;
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
          serviceFeeCents: true,
          tipCents: true,
          currency: true,
          authorizedAt: true,
          authCode: true,
          cardBrand: true,
          providerTxId: true,
          walletId: true,
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
        serviceFeeCents: payment.serviceFeeCents,
        topUp: Boolean(payment.walletId),
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
   * Lookup público por qrToken (cliente escanea, sin auth; y el sondeo de las
   * apps del personal). El id solo cuando ya está pagado: de él sale el código
   * de confirmación del «Pagado» (confirmation-code.ts), y antes de pagar una
   * página falsa lo enseñaría sin pagar. Las apps del personal comparan el id
   * del sondeo con el suyo: las de ahora aceptan la respuesta sin id (es la de
   * su QR); las de antes la ignoran hasta el pagado, que sí lo lleva.
   */
  async getByToken(qrToken: string): Promise<PublicPaymentView> {
    // Cross-tenant: el token es público pero único; bypass RLS
    const payment = await this.prisma.asSystem((tx) =>
      tx.payment.findUnique({
        where: { qrToken },
        include: {
          venue: { select: { name: true } },
          terminal: { select: { label: true } },
          // El último intento: cuándo salió hacia el banco (la espera del personal).
          attempts: { orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } },
        },
      }),
    );
    if (!payment) throw new NotFoundException('QR not found or expired');

    const paid = PAID_STATES.has(payment.status as PaymentMachineState);
    // Esperando al banco o sin su respuesta: desde cuándo (sin intentos, cobros
    // de antes de la Fase 0: desde que cambió de estado). No dice nada más del intento.
    const waiting = payment.status === 'AUTHORIZING' || payment.status === 'ORPHAN';
    // Pagando con bitcoin: la pantalla del personal deja cancelar mientras la factura espera el pago.
    const bitcoin = payment.provider === 'BTCPAY' ? await this.bitcoinStateOf(payment.id, payment.status) : null;
    const attemptAt = payment.attempts?.[0]?.createdAt ?? payment.updatedAt;
    // Ya pagado: cómo se pagó, para el PAGADO del personal («Con tarjeta»).
    // Esta ruta es pública por el token del QR: nunca lleva cifras de la tarjeta.
    const charged = paid
      ? await this.prisma.asSystem((tx) =>
          tx.paymentAttempt.findFirst({
            where: { paymentId: payment.id, status: 'APPROVED' },
            orderBy: { createdAt: 'asc' },
            select: { payMethod: true },
          }),
        )
      : null;
    const payMethod = paid ? paidMethodOf(payment.provider, charged?.payMethod ?? null) : null;
    return {
      ...(paid ? { id: payment.id } : {}),
      // 'wallet': pagó con Apple Pay o Google Pay (el banco no dice cuál de los dos); 'bitcoin': con BTCPay.
      ...(payMethod ? { payMethod } : {}),
      amountCents: payment.amountCents,
      // La fija el cobro al crearse (no cambia): el personal la enseña aparte.
      serviceFeeCents: payment.serviceFeeCents,
      currency: payment.currency,
      status: payment.status,
      venueName: payment.venue.name,
      terminalLabel: payment.terminal.label,
      qrExpiresAt: payment.qrExpiresAt.toISOString(),
      ref: formatChargeRef(payment.ref),
      // Ya pagado: la propina que dejó (el PAGADO del personal sin tiempo real la necesita).
      ...(paid ? { tipCents: payment.tipCents } : {}),
      ...(waiting ? { attemptStartedAt: attemptAt.toISOString() } : {}),
      // Pagando en su banco: se dice ('none'), para que la pantalla no lo deduzca de que falte el campo.
      ...(bitcoin ? { bitcoin } : payment.status === 'AUTHORIZING' ? { bitcoin: 'none' as const } : {}),
    };
  }

  /**
   * La factura de bitcoin del cobro: esperando el pago, con el pago en la red o
   * cerrada con un problema (AUTHORIZING); cerrada sin pagarse y el cobro otra vez
   * abierto (AWAITING_CAPTURE: solo se llega así con BTCPAY). En otro estado, nada.
   */
  private async bitcoinStateOf(paymentId: string, status: string): Promise<BitcoinPayState | null> {
    if (status === 'AWAITING_CAPTURE') return 'closed';
    if (status !== 'AUTHORIZING') return null;
    const open = await this.prisma.asSystem((tx) =>
      tx.btcpayInvoice.findFirst({ where: { paymentId, status: { in: ['New', 'Processing'] } }, select: { status: true } }),
    );
    if (!open) return 'problem';
    return open.status === 'Processing' ? 'confirming' : 'open';
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
                 "revenueCategory", "operatorCommissionBps", "serviceFeeCents",
                 "posOperationNumber"
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
                 provider = ${(result.nextContext.provider ?? p.provider) as 'WIPAY' | 'PEANPE' | 'PAYTEF' | 'REDSYS' | 'BTCPAY' | null}::"Provider",
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
          // Reservados: el pago (señal, resto o todo) se apunta en su reserva aquí mismo.
          await applyReservationPayment(tx, p, traceId);
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
      // El mapa del dinero: con líneas, la comisión va por línea (cada
      // sección con su %); un cobro de una sola sección da lo de siempre.
      const lines = await tx.$queryRaw<
        Array<{ category: string; amountCents: number; operatorCommissionBps: number | null; serviceOperatorId: string | null }>
      >`
        SELECT category, "amountCents", "operatorCommissionBps", "serviceOperatorId" FROM payment_lines WHERE "paymentId" = ${paymentId}::uuid
      `;
      // Gana la compañera que lo cobró o, si lo cobró otra persona a su nombre
      // (cobro por el encargado), la del servicio, con el % fijado en cada
      // línea al cobrar (las demás, 0). Sin ninguna de las dos, no hay ganancia.
      const servedId = creatorRole === 'OPERATOR' ? null : (lines.find((l) => l.serviceOperatorId)?.serviceOperatorId ?? null);
      const earnerId = creatorRole === 'OPERATOR' ? p.createdByUserId : servedId;
      if (earnerId) {
        const creator = { id: earnerId };
        const commission =
          lines.length > 0
            ? lineCommission(
                lines.map((l) => ({
                  amountCents: l.amountCents,
                  bps:
                    l.operatorCommissionBps ??
                    (servedId
                      ? 0
                      : resolveBpsForOperator({
                          category: l.category,
                          userCommissionBpsOverride: creatorCommissionBps,
                          venueMap: venueCommissionMap as Partial<OperatorCommissionDefaults>,
                        })),
                })),
              )
            : lineCommission([{ amountCents: p.amountCents, bps: bpsForOperator }]);
        const bps = commission.commissionBps;
        const commissionCents = commission.commissionCents;

        // Tip: si la propina va a la chica (o a beneficiary explícito que
        // coincide con ella), 100% se suma al earning. Si va a venue/shared
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
      walletId: string | null;
      serviceFeeCents?: number;
    },
  >(tx: TransactionalClient, p: T, event: { provider: string; providerTxId: string }): Promise<T> {
    const charged = await readChargedTip(tx, p.id, event);
    const settled = settleChargedTip({
      amountCents: p.amountCents,
      tipCents: charged?.tipCents ?? 0,
      tipGoesTo: p.tipGoesTo,
      creatorRole: charged?.creatorRole ?? null,
      serviceFeeCents: refundableFeeCents(p),
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
             -- Recarga: el cliente se queda (un «Me voy» pendiente ya no vale, como en efectivo).
             "closeRequestedAt" = NULL,
             "updatedAt" = now()
       WHERE id = ${w.id}::uuid
    `;
    this.logger.log(
      `Payment ${paymentId} AUTHORIZED → wallet ${w.id} credited +${p.amountCents}c (new balance: ${w.balanceCents + p.amountCents})`,
    );
    // Detalle del pago: el saldo antes y después de esta recarga (el que ve el cliente).
    await insertPaymentEvent(tx, {
      paymentId,
      tenantId: p.tenantId,
      eventType: WALLET_CREDITED_EVENT,
      payload: { walletId: w.id, amountCents: p.amountCents, balanceBeforeCents: w.balanceCents, balanceAfterCents: w.balanceCents + p.amountCents },
      traceId: this.cls.get('ctx')?.traceId,
    });
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
   * «Cancelar cobro»: cualquier cobro SIN PAGAR del local, lo cancele quien lo
   * cancele del personal del local (chica, camarero, recepción, encargado o
   * dueño). El cobro de otro local no se encuentra (404).
   *  - Antes de que el cliente vaya a su banco (CREATED, AWAITING_CAPTURE): sí.
   *  - Con el cliente en su banco (AUTHORIZING con una pasarela): no durante
   *    los primeros 2 minutos (409 CANCEL_AT_BANK_TOO_SOON, cancel-at-bank.ts);
   *    pasados sin respuesta del banco, sí.
   *  - Con la factura de bitcoin abierta: sí, sin esperar; con el bitcoin ya en
   *    la red, 409 BITCOIN_CONFIRMING.
   *  - La recarga cobrada en el datáfono sin comprobar (la tarjeta ya pagó):
   *    nunca, ni pasados los 2 minutos (no está en su banco): 409
   *    CANCEL_HELD_ON_READER, la resuelven en el panel (reader-hold.ts).
   * Queda quién lo canceló (en el evento) y con qué móvil. Si el banco lo cobra
   * después, sigue CANCELED y queda en Incidencias (paid-after-cancel.ts).
   * Pagado o cerrado: 409.
   */
  async cancel(
    paymentId: string,
    actor: { userId: string; role: string; tenantId: string },
  ): Promise<{ status: PaymentMachineState }> {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Payment not found');

    try {
      // H2: pasamos expectedTenantId — transition() valida que payment.tenantId
      // coincide con el del actor, defensa cross-tenant aunque la query previa
      // ya filtra por CLS middleware.
      // Quién lo canceló (en el evento) y con qué móvil, en la misma transacción.
      await this.transition(paymentId, { type: 'CANCELED', reason: 'user-canceled', byUserId: actor.userId }, actor.tenantId, {
        prepare: async (tx, locked) => {
          // Con el cobro bloqueado: la recarga del datáfono sin comprobar, el bitcoin en la red y los 2 minutos en su banco.
          await assertCancelable(tx, locked);
          await recordPaymentDevice(tx, this.cls.get('ctx'), { id: locked.id, tenantId: locked.tenantId }, 'cancel');
        },
      });
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        throw new ConflictException(
          `Payment cannot be canceled in state ${payment.status}`,
        );
      }
      throw err;
    }
    await this.afterCancel(paymentId, payment.tenantId);
    return { status: 'CANCELED' };
  }

  /**
   * El pago a medias de un reservado, al anular la reserva (el local o el
   * cliente) o al elegir otro pago: con las mismas comprobaciones que «Cancelar
   * cobro» (con el cobro bloqueado: con el bitcoin ya en la red, 409
   * BITCOIN_CONFIRMING) y cerrando su factura de bitcoin (cancelHooks). Solo si
   * sigue sin empezar o con su factura de bitcoin abierta: con la tarjeta ya en
   * el banco, pagado o cerrado no se toca y devuelve false. Un bitcoin que llegue
   * después da con el cobro cancelado: Incidencias, nunca a un saldo en silencio.
   */
  async cancelReservationPayment(paymentId: string, tenantId: string, event: { reason: string; byUserId?: string }): Promise<boolean> {
    try {
      await this.transition(paymentId, { type: 'CANCELED', ...event }, tenantId, {
        prepare: async (tx, locked) => {
          if (!reservationPaymentCancelable(locked)) throw new InvalidTransitionError(locked.status, 'CANCELED');
          await assertCancelable(tx, locked);
        },
      });
    } catch (err) {
      if (err instanceof InvalidTransitionError) return false;
      throw err;
    }
    await this.afterCancel(paymentId, tenantId);
    return true;
  }

  /**
   * Lo que diría ahora «Cancelar cobro» de este cobro, sin cancelar nada (para
   * avisar antes, p. ej. el resto en efectivo en la puerta): el 409, o null si
   * se podría cancelar.
   */
  async cancelBlocker(paymentId: string, tenantId: string): Promise<ConflictException | null> {
    return this.prisma.asSystem(async (tx) => {
      const p = await tx.payment.findFirst({
        where: { id: paymentId, tenantId },
        select: { id: true, tenantId: true, status: true, provider: true, posOperationNumber: true },
      });
      if (!p) return null;
      try {
        await assertCancelable(tx, { ...p, status: p.status as PaymentMachineState });
        return null;
      } catch (err) {
        if (err instanceof ConflictException) return err;
        throw err;
      }
    });
  }

  /** Cancelado: la factura de bitcoin abierta se cierra (en BTCPay, si la clave deja; si no, caduca sola). */
  private async afterCancel(paymentId: string, tenantId: string): Promise<void> {
    // (`?? []`: las pruebas arman el servicio sin pasar por el constructor.)
    for (const hook of this.cancelHooks ?? []) {
      await hook(paymentId, tenantId).catch((e: unknown) =>
        this.logger.error(`Cancelar ${paymentId}: el cierre de la factura de bitcoin falló: ${(e as Error).message}`),
      );
    }
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
    dto: { posReceiptRef: string; posReceiptPhoto?: string; notes?: string; chargedCents?: number },
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
    if (payment.qrExpiresAt <= new Date()) {
      throw new ConflictException({ message: POS_PAYMENT_EXPIRED, code: POS_PAYMENT_EXPIRED_CODE });
    }
    // Anti auto-confirm: la chica no se confirma sus propios POS (camarero sí).
    if (actor.role === 'OPERATOR' && payment.createdByUserId === actor.userId) {
      throw new ForbiddenException(
        'No puedes confirmar tu propio cobro POS. Llama al camarero.',
      );
    }
    // Lo que se cobró en el datáfono: el total, con la «Comisión del servicio» si la lleva.
    const charged = posChargeProblem(payment, dto.chargedCents);
    if (charged) throw charged;

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

    // Lo devolvible: importe + «Comisión del servicio» (un POS nunca es una recarga).
    const noTip = { tipCents: 0, availableAmountCents: locked.amountCents + refundableFeeCents(locked), tipGoesTo: null };
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
    // Detalle del pago: el móvil de quien lo confirmó con el ticket del datáfono.
    await recordPaymentDevice(tx, this.cls.get('ctx'), { id: locked.id, tenantId: locked.tenantId }, 'pos');
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
        createdBy: { select: { displayName: true, email: true, role: true } },
        terminal: { select: { zone: true, label: true } },
      },
    });
    // A nombre de una compañera (cobro por el encargado), la de su servicio: la lista ya pone «Chica: …».
    const byOthers = rows.filter((p) => p.createdBy?.role !== 'OPERATOR').map((p) => p.id);
    const served = await this.prisma.asSystem((tx) => servedOperators(tx, { paymentIds: byOthers }));
    return rows.map((p) => ({
      id: p.id,
      // Lo que se cobra en el datáfono: el importe + la «Comisión del servicio»
      // (así una app anterior, que enseña amountCents, cobra lo que toca).
      amountCents: p.amountCents + p.serviceFeeCents,
      baseAmountCents: p.amountCents,
      serviceFeeCents: p.serviceFeeCents,
      currency: p.currency,
      createdAt: p.createdAt.toISOString(),
      qrExpiresAt: p.qrExpiresAt.toISOString(),
      createdByName: (served.has(p.id) ? served.get(p.id)?.name : (p.createdBy?.displayName ?? p.createdBy?.email)) ?? '—',
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
  ): Promise<{ status: PaymentMachineState; providerTxId?: string; result?: AuthorizeResult }> {
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
    // El pedido ya está abierto: si Redis falla ahora, el cliente llega al banco
    // igual (el aviso firmado lo cierra; el barrido del arranque lo concilia).
    try {
      await enqueueOrphanReconcile(
        this.orphanReconcileQueue,
        this.logger,
        { paymentId: payment.id, tenantId: payment.tenantId },
        ORPHAN_RECONCILE_DELAY_MS,
      );
    } catch (err) {
      this.logger.error(`Payment ${payment.id}: abierto en el banco sin la conciliación encolada (${(err as Error).message})`);
    }

    this.logger.log(
      `Payment ${payment.id} authorizing via ${credential.provider} (txId=${providerTxId})`,
    );
    return { status: 'AUTHORIZING', providerTxId, result: opened.result };
  }

  /**
   * Al ir al banco se vuelve a mirar lo que se miró al crear el cobro: el
   * local (o su negocio) en pausa → 423, y la forma de cobro apagada en
   * Ajustes («QR con tarjeta»; la recarga, también «Saldo») → 409. Un QR
   * creado antes no se cobra después, como el cobro con el saldo. OxioParty:
   * creado antes del fin de la fiesta y pagado después, tampoco (423
   * EVENT_ENDED). OxioPay: no se mira nada más.
   */
  private async assertVenueStillCharges(payment: { tenantId: string; walletId: string | null }): Promise<void> {
    const venue = await this.prisma.asSystem((tx) =>
      tx.venue.findUnique({ where: { id: payment.tenantId }, select: { ...VENUE_PAUSE_SELECT, ...VENUE_METHODS_SELECT } }),
    );
    assertVenueNotPaused(venue);
    if (isPartyEdition()) await this.prisma.asSystem((tx) => assertEventOpen(tx, payment.tenantId));
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
    payment: { id: string; tenantId: string; amountCents: number; serviceFeeCents?: number; tipCents: number; currency: string },
    provider: Provider,
    choice?: CheckoutChoice,
  ): Promise<OpenedCheckout> {
    // Solo Redsys cobra y reparte la propina (la del aprobado pasa al cobro
    // en transition). Las demás pasarelas cobran el importe, como antes.
    // Todas cobran también la «Comisión del servicio» fijada al crear (0 en
    // los cobros de antes: siguen con su importe de siempre).
    const tipCents = provider === 'REDSYS' ? (choice?.tipCents ?? payment.tipCents) : null;
    const chargeCents = payment.amountCents + (payment.serviceFeeCents ?? 0) + (tipCents ?? 0);
    // El id del intento se elige aquí: con él nombran el pago Paytef (clientID)
    // y Cecabank (Num_operacion), que lo ve el cliente. Del id del cobro sale
    // el código de confirmación: no va a la pasarela entero.
    const attemptId = randomUUID();
    try {
      const result = await this.gateways.get(provider).authorize({
        tenantId: payment.tenantId,
        paymentId: payment.id,
        amountCents: chargeCents,
        currency: payment.currency,
        terminalExternalId: '',
        reference: payment.id,
        attemptId,
        ...(provider === 'REDSYS' && choice?.method ? { payMethod: choice.method } : {}),
        ...(choice ? { language: choice.language } : {}),
      });
      return { attemptId, result, chargeCents, tipCents };
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
    const { attemptId, result, chargeCents, tipCents } = opened;
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
        id: attemptId,
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
    // Detalle del pago: el móvil del cliente que va a pagar con este intento.
    const ctx = this.cls.get('ctx');
    await recordPaymentDevice(tx, { ...ctx, device: choice?.device ?? ctx?.device }, payment, 'card', { who: 'client', attemptId });
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
               e."reversedCents", (p."amountCents" + p."serviceFeeCents" + p."tipCents") AS "chargedCents", e."payoutId"
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
    // Con datáfono (POS_EXTERNAL) el QR abre la app del personal para confirmar
    // la venta del lector; si no, la página de pago (ver pay-qr-url.ts).
    const qrUrl = cardQrUrl(p);
    const qrPngDataUrl = await QRCode.toDataURL(qrUrl, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 320,
    });

    return {
      id: p.id,
      amountCents: p.amountCents,
      // «Comisión del servicio» de este cobro (la paga el cliente encima de
      // amountCents si paga con tarjeta o datáfono; con el saldo, no).
      serviceFeeCents: p.serviceFeeCents ?? 0,
      serviceFeeBps: p.serviceFeeBps ?? null,
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
