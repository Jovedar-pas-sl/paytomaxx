import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  confirmationCode,
  fichaNumberText,
  formatChargeRef,
  isWalletCardToken,
  nightSettingsOf,
  normalizeWalletCardUid,
  paymentMethodsOf,
  sectionMeta,
  sectionsOf,
  stepUpActions,
  type ChargeAuthMethod,
  type ChargeLineInput,
  type Role,
} from '@nightpay/contracts';
import type { Prisma } from '@nightpay/db';
import { ClsService } from 'nestjs-cls';
import type { RequestContext } from '../../common/context/request-context';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  insertPaymentEvent,
  paymentDevicePayload,
  PAYMENT_DEVICE_EVENT,
  WALLET_CHARGE_CREATED_ACTION,
  WALLET_CHARGE_SETTLED_ACTION,
  withoutIp,
} from '../payments/payment-device';
import { resolveBpsForOperator, type RevenueCategory } from '../payments/commission';
import { lineCommission, type DraftLine } from '../payments/charge-lines';
import { resolveChargeOrThrow } from '../payments/charge-request';
import { insertChargeLines, insertInvitationEarnings, linesOf, nextChargeRef } from '../payments/charge-store';
import { invitationEarnings } from '../payments/invitation-lines';
import {
  alreadyPaid,
  cancelCardForSaldo,
  isCardPaid,
  lockLinkedCard,
  moveLinesToSaldo,
  saldoMayPay,
} from '../payments/cobro-link';
import { hashPin, PIN_MAX_FAILS, PIN_PROBLEM_TEXT, pinProblem, verifyPin } from './wallet-pin';
import { reopenData } from './wallet-activation';
import { mergedWalletIds } from './wallet-merge-chain';
import { clientRefundState, refundCards, type ClientRefundState } from './wallet-refund-view';
import {
  ISSUED_CARD_STATUSES,
  attachCard,
  createCardToken,
  isIssuedCard,
  moveWalletCards,
  recordCardEvents,
  returnWalletCards,
  type CardBy,
} from './wallet-card-ops';
import {
  cardRefundCapCents,
  cashPayoutCapCents,
  cashPayoutRefusal,
  payoutAmounts,
  walletCash,
  type PayoutAmounts,
} from './wallet-cash-limits';
import { firstTopUp, isFreshTopUpBy, type TopUpBy } from './wallet-fresh-topup';
import { topUpTarget } from './wallet-topup-target';
import {
  PinRequiredException,
  noPinCardProblem,
  noPinProblem,
  noPinSpentSince,
  noPinWindowStart,
} from './wallet-nopin';
import { assertVenueAcceptsCharges } from '../venues/venue-pause';
import { TipsDisabledException, assertVenueAcceptsMethods } from '../venues/venue-methods';
import { tipsForbidden } from '../venues/charge-rights';
import { maxTipCents } from '../payments/tip';
import { TotpService } from '../auth/totp.service';
import { assertManagerTwoFactor, assertTwoFactorCode, cashApprovalThreshold } from './wallet-two-factor';
import { receptionAskedManager } from './reception-payout-rules';
import { WalletBlockedException } from './wallet-blocked';
import { activationPath, issueActivationToken } from './wallet-activation-token';
import { saldoCredits, serviceFeeSaldoCents, serviceFeeSpendCents } from './wallet-fee-saldo';
import { passChargeSecret, passChargeTokenValid, passChargeWalletId } from './google-wallet/pass-charge-token';
// Solo el TIPO: el valor se resuelve con ModuleRef (ciclo Wallets→Refunds→Payments→Wallets).
import type { RefundsService } from '../refunds/refunds.service';
import { REFUNDS_SERVICE } from '../refunds/refunds.token';
import {
  allocateCardRefund,
  decideAccept,
  effectiveRequestStatus,
  formatWalletCode,
  newWalletToken,
  normalizeWalletCode,
  sameWalletGroup,
  type ChargeRequestStatus,
  type WalletPayoutMethod,
} from './wallet-rules';

type Actor = { userId: string; role: Role; tenantId: string };

/** Lo devuelto. remainingCents: lo que sigue en el saldo (en efectivo solo sale lo que entró en efectivo). */
export interface WalletPayoutResult {
  refundedCents: number;
  method: WalletPayoutMethod;
  remainingCents?: number;
}

/**
 * Lo que haría «Devolver saldo» ahora, sin tocar nada (GET …/payout-preview):
 * el panel enseña estas cifras antes de confirmar, no el saldo entero.
 */
export interface WalletPayoutPreview extends PayoutAmounts {
  balanceCents: number;
  /** Una devolución a la tarjeta que quedó a medias: «A la tarjeta» la termina (y en efectivo, nada hasta entonces). */
  pendingCardCents: number | null;
}

/** Lo que se pide al devolver el saldo; expectedAmountCents: la cifra que vio el panel (si ya es otra, 409). */
export interface WalletPayoutInput {
  method: WalletPayoutMethod;
  bankReference?: string;
  note?: string;
  totpCode?: string;
  expectedAmountCents?: number;
}

export interface WalletLookup {
  walletId: string;
  code: string;
  balanceCents: number;
  label: string | null;
  homeVenueName: string;
  /** El saldo se cargó en este local (la devolución a la tarjeta solo desde aquí). */
  isHomeVenue: boolean;
  /** El cliente pulsó "Me voy". */
  closeRequested: boolean;
  /**
   * @deprecated Siempre false: ya no hay cobros que el cliente acepte en su
   * página (se paga con el QR de la chica o con el PIN). Se deja para no
   * romper las apps que aún lo leen.
   */
  pendingRequest: false;
  /** Puede pagar sin sacar el móvil, con su PIN. */
  hasPin: boolean;
  /** 5 PIN fallidos: hasta que lo desbloquee el encargado. */
  pinLocked: boolean;
  /** Tiene ficha NFC (la acerca y pone su PIN). */
  hasCard: boolean;
}

/** Cómo dice el cliente cuál es su saldo, sin su móvil: su código o su ficha NFC. */
export type WalletRef = { code: string } | { card: string; uid?: string | null; requestId?: string };
/** La ficha acercada y, al pagar, el cobro (para apuntar con él una posible copia). */
type CardRefInput = { card: string; uid?: string | null; requestId?: string };
/** Con qué se dijo de quién era el saldo al pagar con PIN (detalle del pago: «Ficha nº…»). */
type PinVia = 'ficha' | 'pase' | 'código';
function pinViaOf(input: object): PinVia {
  return 'card' in input ? 'ficha' : 'walletToken' in input ? 'pase' : 'código';
}

/** Datáfono vinculado (Authorization: Device): no hay persona, solo su local. */
export interface TerminalActor {
  terminalId: string;
  tenantId: string;
}

/** En el datáfono, además: el QR de su pase de Google Wallet (/w/<token>). */
export type TerminalWalletRef = WalletRef | { walletToken: string };

/**
 * En el móvil del personal, además: el QR del pase de Google Wallet del
 * cliente, pero solo el de cobrar (/c/<token>, pass-charge-token.ts). El
 * enlace del saldo (/w/<token>) no se acepta aquí: da todos los poderes.
 */
export type StaffWalletRef = WalletRef | { walletToken: string };

/**
 * Lo que ve el móvil del personal del pase antes del PIN, como el datáfono:
 * ni lo que tiene, ni su código entero, ni el enlace del saldo.
 */
export interface StaffPassCheck {
  /** "K7Q-•••": que el cliente reconozca su saldo sin enseñarlo entero. */
  codeHint: string;
  hasPin: boolean;
  pinLocked: boolean;
  /** El PIN lo puso quien cobra o quien hizo el cobro: lo tiene que cobrar otra persona. */
  ownPin: boolean;
  /** Le llega para este cobro. */
  enough: boolean;
}

/**
 * Lo que ve el datáfono del saldo antes del PIN: ni lo que tiene ni su
 * nombre, solo si le llega para este cobro.
 */
export interface TerminalWalletCheck {
  /** "K7Q-•••": que el cliente reconozca su saldo sin enseñarlo entero. */
  codeHint: string;
  hasPin: boolean;
  pinLocked: boolean;
  /** El PIN lo puso el personal: en el datáfono no vale (nadie sabe quién lo sostiene). */
  pinByStaff: boolean;
  /** Le llega para este cobro. */
  enough: boolean;
  /**
   * Con su NFC (leído con su número de serie) se paga sin PIN: hasta el
   * máximo y el tope de la noche del local. Es un aviso: el cobro lo vuelve
   * a mirar con el saldo bloqueado (si no, 409 PIN_REQUIRED).
   */
  noPin: boolean;
}

/** Lo que se cuenta del NFC sin PIN al cobrar (para el registro). */
interface NoPinSettled {
  spentBeforeCents: number;
  nightCapCents: number;
}

/** La ficha acercada en la recepción del datáfono: de qué saldo es, sin enseñarlo. */
export interface ReceptionCardView {
  walletId: string;
  codeHint: string;
  hasPin: boolean;
  /** El saldo es de este local (una recarga con tarjeta solo se hace aquí). */
  isHomeVenue: boolean;
}

/** El saldo recién recargado en la recepción del datáfono (el cliente está delante). */
export interface ReceptionWalletView {
  walletId: string;
  code: string;
  balanceCents: number;
  hasPin: boolean;
  hasCard: boolean;
}

export interface ChargeRequestView {
  id: string;
  /** Referencia corta (C-0001): la de la chica en el PAGADO y la del cliente en sus movimientos. */
  ref: string | null;
  status: ChargeRequestStatus;
  amountCents: number;
  /** La propina que pidió el cliente (aparte del importe; el saldo paga las dos). */
  tipCents: number;
  serviceName: string | null;
  expiresAt: string;
  newBalanceCents: number | null;
  /** Pagado: cómo lo autorizó el cliente (NFC sin PIN, PIN, Face ID o el encargado). Null si no o de antes. */
  paidWith?: ChargeAuthMethod | null;
  /** Cobro único: no lo pagó el saldo porque ya lo pagó la tarjeta (el PAGADO es el del cobro con tarjeta). */
  paidElsewhere?: boolean;
}

/** Cobro con QR para la chica: lo mismo que un cobro y el token del QR. */
export interface QrChargeView extends ChargeRequestView {
  payToken: string;
}

/** Lo que ve el cliente al escanear el QR del cobro. */
export interface QrChargeClientView {
  status: ChargeRequestStatus;
  amountCents: number;
  serviceName: string | null;
  venueName: string;
  requestedByName: string | null;
  expiresAt: string;
  /** Cuándo se pagó (solo si ya está pagado): el «Ya pagado · hace 23 min». */
  paidAt: string | null;
  /** Cobro único: ya lo pagó con tarjeta (del saldo no se cobró nada). */
  paidElsewhere?: boolean;
  /**
   * El código corto del cobro único (el de su cobro con tarjeta): el mismo que
   * ve el personal en su PAGADO. Sin cobro con tarjeta enlazado, null: no se
   * enseña ninguno (nada inventado). La página solo lo pinta si ya está
   * pagado (si no, llega en la respuesta del pago).
   */
  code?: string | null;
}

/** Respuesta de POST /s/:token/pay: lo cobrado, lo que le queda y el código del cobro único. */
export interface QrChargePaid {
  amountCents: number;
  balanceCents: number;
  code: string | null;
}

/** Para el encargado: cobros con QR sin pagar. */
export interface PendingQrCharge {
  id: string;
  amountCents: number;
  serviceName: string | null;
  requestedByName: string;
  createdAt: string;
  expiresAt: string;
}

export interface ClientWalletState {
  code: string;
  balanceCents: number;
  status: string;
  closeRequested: boolean;
  /** El cliente activó Face ID (paga escaneando el QR de la chica). */
  hasFaceId: boolean;
  /** Ya tiene PIN (para pagar sin sacar el móvil). */
  hasPin: boolean;
  /** Lleva una ficha NFC dada a este saldo (paga acercándola, con su PIN). */
  hasCard: boolean;
  /** «0417»: el número de su NFC (el impreso si lo tiene), para la tarjeta de su página; null sin NFC. */
  fichaNumber: string | null;
  /** El local del saldo («Tu saldo · Sala Medianoche»). */
  venueName: string | null;
  /** Esta recarga se sumó a otro saldo del mismo cliente. */
  merged: boolean;
  /** «Me voy»: cuánto se devuelve, cómo y en qué paso va (null = no hay devolución). */
  refund: ClientRefundState | null;
  /** Últimas 4 cifras de las tarjetas de sus recargas (a ellas se devuelve a la tarjeta). */
  cards: string[];
  movements: Array<{
    kind: 'topup' | 'consumption' | 'payout';
    amountCents: number;
    label: string;
    /**
     * El texto de la fila en el idioma de la página (recargas y devoluciones:
     * WalletText.mv); sin él, `label` tal cual (los consumos: lo que se pidió).
     */
    labelKey?: 'topUp' | 'topUpCash' | 'topUpCashVoid' | 'payoutCash' | 'payoutCard';
    venueName: string | null;
    at: string;
    /** Referencia del cobro (C-0001) en consumos y recargas con tarjeta; null en el resto y en los antiguos. */
    ref: string | null;
    /** Color de la sección del consumo (el del local); null en recargas y devoluciones. */
    color: string | null;
    /**
     * El pago para abrir su detalle (GET /w/:token/movements/:kind/:id): lo
     * pagado con el saldo (SALDO) y las recargas con tarjeta (PAYMENT). Null en
     * las recargas en efectivo y las devoluciones.
     */
    detail?: { kind: 'PAYMENT' | 'SALDO'; id: string } | null;
    /**
     * Un pago con el saldo que el local deshizo: el dinero volvió a su saldo
     * (la fila lo dice, «Devuelto a tu saldo»; sin quién ni por qué).
     */
    returned?: boolean;
  }>;
}

/** El QR del cobro con Face ID caduca a los 5 minutos. */
const QR_CHARGE_TTL_MS = 5 * 60 * 1000;

const REQUEST_ERRORS: Record<'not-pending' | 'expired' | 'wallet-closed' | 'insufficient' | 'blocked', string> = {
  'not-pending': 'Este cobro ya no está pendiente',
  expired: 'Este cobro ha caducado: pide a la chica que lo repita',
  'wallet-closed': 'Este saldo ya está cerrado',
  insufficient: 'No hay saldo suficiente para este cobro',
  blocked: 'Este saldo está bloqueado: no se puede pagar con él. Avisa al encargado.',
};

const REQUEST_ERROR_CODES: Record<keyof typeof REQUEST_ERRORS, string> = {
  'not-pending': 'CHARGE_NOT_PENDING',
  expired: 'CHARGE_EXPIRED',
  'wallet-closed': 'WALLET_CLOSED',
  insufficient: 'WALLET_INSUFFICIENT',
  blocked: 'WALLET_BLOCKED',
};

/**
 * Un PIN que puso el personal sin el cliente: ni quien lo puso cobra con él
 * ni se paga con él un cobro suyo (hacen falta dos personas, como sin Face ID).
 * La misma regla que payQrChargeWithPin, para decirlo antes del PIN.
 */
function pinSetByStaffHere(
  wallet: { pinSetById: string | null },
  actor: { userId: string },
  request: { requestedByUserId: string | null },
): boolean {
  return Boolean(wallet.pinSetById) && (wallet.pinSetById === actor.userId || wallet.pinSetById === request.requestedByUserId);
}

/** 409 del cobro con QR, con su `code` (la página del cliente lo traduce; las apps leen el texto). */
function requestError(reason: keyof typeof REQUEST_ERRORS): ConflictException {
  return new ConflictException({ message: REQUEST_ERRORS[reason], code: REQUEST_ERROR_CODES[reason] });
}

/** «Sumar a mi saldo» que no se puede hacer (el texto, para las apps; el code, para la página). */
function mergeError(message: string, code = 'MERGE_NOT_ALLOWED'): ConflictException {
  return new ConflictException({ message, code });
}

const MERGE_BLOCKED = 'Uno de los dos saldos está bloqueado: no se pueden juntar. Pregunta en el local.';

/**
 * Saldo NightPay. La chica hace el cobro con un QR: el cliente lo paga desde
 * su móvil con Face ID o, sin sacar el móvil, con su código o su ficha NFC y
 * su PIN; sin batería, lo aprueba otro encargado. Al irse, el encargado le
 * devuelve el saldo a la tarjeta (hecho en BBVA) o en efectivo.
 */
/** Juntar saldos desde este importe sale en Incidencias y por Telegram. */
export const MERGE_ALERT_CENTS = 10_000;

@Injectable()
export class WalletChargesService {
  private readonly logger = new Logger(WalletChargesService.name);
  private readonly prisma: PrismaService;
  private readonly audit: AuditService;
  private readonly moduleRef: ModuleRef;
  private readonly totp: TotpService;

  /** El contexto de la petición: el dispositivo con el que se paga (detalle del pago). */
  private readonly cls: Pick<ClsService<{ ctx: RequestContext }>, 'get'> | null;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(AuditService) audit: AuditService,
    @Inject(ModuleRef) moduleRef: ModuleRef,
    @Inject(TotpService) totp: TotpService,
    @Optional() @Inject(ClsService) cls?: ClsService<{ ctx: RequestContext }>,
  ) {
    this.prisma = prisma;
    this.audit = audit;
    this.moduleRef = moduleRef;
    this.totp = totp;
    this.cls = cls ?? null;
  }

  // ─── Personal del local ────────────────────────────────────────────────

  /** El código que enseña el cliente → su saldo (si vale en este local). */
  async lookup(venueId: string, rawCode: string): Promise<WalletLookup> {
    return this.lookupWallet(venueId, await this.walletByCode(venueId, rawCode));
  }

  /**
   * Por su id: la recarga que la chica acaba de cobrar (para enseñar el código
   * y que elija su PIN). La chica o el camarero, solo la suya y recién hecha.
   */
  async lookupById(actor: Actor, walletId: string): Promise<WalletLookup> {
    const [wallet, venue] = await Promise.all([
      this.prisma.acrossVenues((tx) => tx.clientWallet.findUnique({ where: { id: walletId } })),
      this.prisma.venue.findUnique({ where: { id: actor.tenantId }, select: { walletGroup: true } }),
    ]);
    const manager = isManager(actor);
    if (
      !wallet ||
      !sameWalletGroup(wallet, { id: actor.tenantId, walletGroup: venue?.walletGroup ?? null }) ||
      (!manager && !(await this.freshTopUpBy(walletId, actor.userId)))
    ) {
      throw new NotFoundException('Saldo no encontrado');
    }
    return this.lookupWallet(actor.tenantId, wallet);
  }

  private async lookupWallet(
    venueId: string,
    wallet: Awaited<ReturnType<WalletChargesService['walletByCode']>>,
  ): Promise<WalletLookup> {
    const [home, cards] = await Promise.all([
      this.prisma.venue.findUnique({ where: { id: wallet.tenantId }, select: { name: true } }),
      this.prisma.acrossVenues((tx) => tx.walletCard.count({ where: { walletId: wallet.id, status: { in: ISSUED_CARD_STATUSES } } })),
    ]);
    return {
      walletId: wallet.id,
      code: formatWalletCode(wallet.shortCode ?? ''),
      balanceCents: wallet.balanceCents,
      label: wallet.identifier,
      homeVenueName: home?.name ?? '',
      isHomeVenue: wallet.tenantId === venueId,
      closeRequested: wallet.closeRequestedAt !== null,
      pendingRequest: false,
      hasPin: wallet.pinHash !== null,
      pinLocked: wallet.pinLockedAt !== null,
      hasCard: cards > 0,
    };
  }

  /**
   * Importe, sección y nombre del cobro, en líneas (el mapa del dinero): de la
   * carta (un pack, una línea por parte) o tecleado en una sección (sin
   * sección: la del puesto de quien cobra o la de su rol). Con el tope de la chica.
   */
  private async resolveCharge(
    actor: Actor,
    input: QrChargeInput,
  ): Promise<{ amountCents: number; category: RevenueCategory; serviceName: string | null; lines: DraftLine[]; tipCents: number }> {
    const charge = await resolveChargeOrThrow(this.prisma, {
      tenantId: actor.tenantId,
      userId: actor.userId,
      role: actor.role,
      lines: input.lines,
      serviceItemId: input.serviceItemId,
      amountCents: input.amountCents,
      requestedCategory: input.category,
      invitedStaffToken: input.invitedStaffToken,
      invitedOperatorId: input.invitedOperatorId,
    });
    const amountCents = charge.amountCents;
    // La propina: con las propinas encendidas en el local y en su puesto, hasta el importe (y 500 €).
    const tipCents = input.tipCents ?? 0;
    if (tipCents > 0) {
      const venue = await this.prisma.asSystem((tx) =>
        tx.venue.findUnique({ where: { id: actor.tenantId }, select: { paymentMethods: true } }),
      );
      if (!paymentMethodsOf(venue?.paymentMethods).tips) throw new TipsDisabledException();
      if (charge.rights && !charge.rights.tips) throw tipsForbidden();
      if (tipCents > maxTipCents(amountCents)) {
        throw new BadRequestException('La propina no puede pasar del importe del cobro ni de 500,00 €');
      }
    }
    // El mismo tope por cobro que tiene la chica con el QR (Ajustes del local).
    if (actor.role === 'OPERATOR') {
      const venue = await this.prisma.venue.findUnique({
        where: { id: actor.tenantId },
        select: { operatorMaxCobroCents: true },
      });
      const max = venue?.operatorMaxCobroCents ?? null;
      if (max !== null && amountCents > max) {
        throw new ForbiddenException(`El máximo que puedes cobrar de una vez es ${eur(max)}`);
      }
    }
    return { amountCents, category: charge.primaryCategory, serviceName: charge.serviceName, lines: charge.lines, tipCents };
  }

  /** La chica espera a que el cliente pague (solo la que lo hizo, o el encargado). */
  async getRequest(actor: Actor, requestId: string): Promise<ChargeRequestView> {
    const request = await this.ownRequest(actor, requestId);
    const walletId = request.walletId;
    const accepted = request.status === 'ACCEPTED';
    const [wallet, consumption, elsewhere] = await Promise.all([
      walletId
        ? this.prisma.acrossVenues((tx) =>
            tx.clientWallet.findUnique({ where: { id: walletId }, select: { balanceCents: true } }),
          )
        : null,
      accepted && request.consumptionId ? this.consumptionAuth(request.consumptionId) : null,
      accepted ? false : this.paidByCard(request),
    ]);
    return {
      ...this.requestView(request, accepted ? (wallet?.balanceCents ?? null) : null),
      paidWith: consumption,
      ...(elsewhere ? { paidElsewhere: true } : {}),
    };
  }

  /** Cómo se autorizó el consumo de un cobro pagado (null en los de antes). */
  private async consumptionAuth(consumptionId: string): Promise<ChargeAuthMethod | null> {
    const c = await this.prisma.asSystem((tx) =>
      tx.walletConsumption.findFirst({ where: { id: consumptionId }, select: { authMethod: true } }),
    );
    const m = c?.authMethod ?? null;
    return m === 'nfc_nopin' || m === 'pin' || m === 'passkey' || m === 'staff' ? m : null;
  }

  /** Cobro único: ¿lo pagó ya la tarjeta? */
  private async paidByCard(request: { linkedPaymentId?: string | null }): Promise<boolean> {
    const paymentId = request.linkedPaymentId;
    if (!paymentId) return false;
    const card = await this.prisma.asSystem((tx) =>
      tx.payment.findUnique({ where: { id: paymentId }, select: { status: true } }),
    );
    return isCardPaid(card?.status);
  }

  /** Retirar el cobro: la chica que lo hizo o el encargado. */
  async cancelRequest(actor: Actor, requestId: string): Promise<{ ok: true }> {
    await this.ownRequest(actor, requestId);
    const res = await this.prisma.asSystem((tx) =>
      tx.walletChargeRequest.updateMany({
        where: { id: requestId, tenantId: actor.tenantId, status: 'PENDING' },
        data: { status: 'CANCELED', decidedAt: new Date() },
      }),
    );
    if (res.count === 0) throw new ConflictException('Este cobro ya no está pendiente');
    return { ok: true };
  }

  /**
   * Un cobro de este local que puede ver quien lo pide: la persona que lo hizo
   * o el encargado / dueño. Al resto, como si no existiera (ni su importe ni
   * en qué saldo se cobró).
   */
  private async ownRequest(actor: Actor, requestId: string) {
    const request = await this.prisma.asSystem((tx) =>
      tx.walletChargeRequest.findFirst({ where: { id: requestId, tenantId: actor.tenantId } }),
    );
    if (!request || (request.requestedByUserId !== actor.userId && !isManager(actor))) {
      throw new NotFoundException('Cobro no encontrado');
    }
    return request;
  }

  // ─── Cliente (página de su saldo, sin cuenta: el enlace es la credencial) ──

  /**
   * Lo que enseña la página del saldo (/w/:token y /w/:token/state). Todo en
   * UNA transacción (antes, ~8 seguidas: la página lo pide tras cada aviso y
   * de respaldo cada 20–30 s; H-1). Sin local: el saldo vale en el grupo.
   */
  async clientState(qrToken: string): Promise<ClientWalletState> {
    const read = await this.prisma.acrossVenues(async (tx) => {
      const wallet = await tx.clientWallet.findUnique({ where: { qrToken } });
      if (!wallet) return null;
      // También los deshechos: la fila dice que el dinero volvió a su saldo.
      const consumptions = await tx.walletConsumption.findMany({
        where: { walletId: wallet.id },
        orderBy: { createdAt: 'desc' },
        take: 30,
        select: { id: true, amountCents: true, tipCents: true, category: true, notes: true, tenantId: true, createdAt: true, reversedAt: true },
      });
      const topUps = await tx.payment.findMany({
        where: { walletId: wallet.id, status: { in: ['AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED'] } },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, amountCents: true, tenantId: true, authorizedAt: true, createdAt: true, cardLast4: true, ref: true },
      });
      // Hechas y la que se está apuntando a la tarjeta (paso «Aprobado» del «Me voy»).
      const allPayouts = await tx.walletPayout.findMany({
        where: { walletId: wallet.id, status: { in: ['DONE', 'PENDING'] } },
        orderBy: { createdAt: 'desc' },
        take: 30,
        select: { amountCents: true, method: true, status: true, tenantId: true, createdAt: true },
      });
      // En efectivo en la recepción (no pasan por el banco).
      const cashTopUps = await tx.walletCashTopUp.findMany({
        where: { walletId: wallet.id },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { amountCents: true, tenantId: true, createdAt: true },
      });
      // Su ficha NFC (dada a este saldo): en «Pagar» se le dice que también paga con ella.
      const issuedCards = await tx.walletCard.findMany({
        where: { walletId: wallet.id, status: { in: ISSUED_CARD_STATUSES } },
        select: { number: true, printedNumber: true },
      });
      const passkeys = await tx.walletPasskey.count({ where: { walletId: wallet.id } });
      const venueIds = [...new Set([wallet.tenantId, ...[...consumptions, ...topUps, ...cashTopUps, ...allPayouts].map((m) => m.tenantId)])];
      const venues = await tx.venue.findMany({ where: { id: { in: venueIds } }, select: { id: true, name: true, sections: true } });
      // La referencia de cada consumo es la de su cobro (C-0001), y su cobro abre el detalle.
      const refRows =
        consumptions.length === 0
          ? []
          : await tx.walletChargeRequest.findMany({
              where: { consumptionId: { in: consumptions.map((c) => c.id) } },
              select: { id: true, consumptionId: true, ref: true },
            });
      return { wallet, consumptions, topUps, allPayouts, cashTopUps, issuedCards, passkeys, venues, refRows };
    });
    if (!read) throw new NotFoundException({ message: 'Saldo no encontrado', code: 'WALLET_NOT_FOUND' });
    const { wallet, consumptions, topUps, allPayouts, cashTopUps, issuedCards, venues } = read;
    // En movimientos, solo las hechas (una a la tarjeta a medias aún no es una devolución).
    const payouts = allPayouts.filter((p) => p.status === 'DONE');
    const hasFaceId = read.passkeys > 0;
    const venueName = (id: string): string => venues.find((v) => v.id === id)?.name ?? '';
    // Cada sección con el nombre y el color que le dio el local del consumo (Ajustes → Secciones); los de fábrica si no los cambió.
    const sectionOfVenue = (id: string, category: string): { label: string; color: string } =>
      sectionMeta(sectionsOf(venues.find((v) => v.id === id)?.sections), category);
    const refs = new Map(read.refRows.flatMap((x) => (x.consumptionId && x.ref ? [[x.consumptionId, formatChargeRef(x.ref)!]] : [])));
    const chargeOf = new Map(read.refRows.flatMap((x) => (x.consumptionId ? [[x.consumptionId, x.id]] : [])));

    const movements: ClientWalletState['movements'] = [
      ...consumptions.map((c) => ({
        kind: 'consumption' as const,
        amountCents: -(c.amountCents + c.tipCents),
        label: c.notes?.split('\n')[0]?.trim() || sectionOfVenue(c.tenantId, c.category).label,
        venueName: venueName(c.tenantId),
        at: c.createdAt.toISOString(),
        ref: refs.get(c.id) ?? null,
        color: sectionOfVenue(c.tenantId, c.category).color,
        detail: chargeOf.has(c.id) ? { kind: 'SALDO' as const, id: chargeOf.get(c.id)! } : null,
        ...(c.reversedAt ? { returned: true } : {}),
      })),
      ...topUps.map((t) => ({
        kind: 'topup' as const,
        amountCents: t.amountCents,
        label: 'Recarga',
        labelKey: 'topUp' as const,
        venueName: venueName(t.tenantId),
        at: (t.authorizedAt ?? t.createdAt).toISOString(),
        ref: formatChargeRef(t.ref),
        color: null,
        detail: { kind: 'PAYMENT' as const, id: t.id },
      })),
      ...cashTopUps.map((t) => ({
        kind: 'topup' as const,
        amountCents: t.amountCents,
        // Una recarga mal tecleada que el encargado anuló: fila negativa.
        label: t.amountCents < 0 ? 'Recarga en efectivo anulada' : 'Recarga en efectivo',
        labelKey: t.amountCents < 0 ? ('topUpCashVoid' as const) : ('topUpCash' as const),
        venueName: venueName(t.tenantId),
        at: t.createdAt.toISOString(),
        ref: null,
        color: null,
      })),
      ...payouts.map((p) => ({
        kind: 'payout' as const,
        amountCents: -p.amountCents,
        label: p.method === 'CASH' ? 'Devuelto en efectivo' : 'Devuelto a la tarjeta',
        labelKey: p.method === 'CASH' ? ('payoutCash' as const) : ('payoutCard' as const),
        venueName: venueName(p.tenantId),
        at: p.createdAt.toISOString(),
        ref: null,
        color: null,
      })),
    ].sort((a, b) => b.at.localeCompare(a.at));

    const closeRequested = wallet.closeRequestedAt !== null;
    return {
      code: formatWalletCode(wallet.shortCode ?? ''),
      balanceCents: wallet.balanceCents,
      status: wallet.status,
      closeRequested,
      hasFaceId,
      hasPin: Boolean(wallet.pinHash),
      hasCard: issuedCards.length > 0,
      fichaNumber: issuedCards[0] ? (issuedCards[0].printedNumber ?? fichaNumberText(issuedCards[0].number)) : null,
      venueName: venueName(wallet.tenantId) || null,
      merged: Boolean(wallet.mergedIntoId),
      refund: clientRefundState({ status: wallet.status, balanceCents: wallet.balanceCents, closeRequested }, allPayouts),
      cards: refundCards(topUps.map((t) => t.cardLast4)),
      movements,
    };
  }

  /**
   * Ata el cobro con QR a este saldo y lo cobra: con el saldo bloqueado se
   * descuenta, se apunta el consumo en el local donde se cobra y la parte de
   * la chica (con la comisión de esa categoría en ese local). Sin local en el
   * contexto y con bypass de RLS: el saldo, el consumo y la parte de la chica
   * pueden ser de locales distintos del grupo. Todo o nada: si algo falla, el
   * rollback deja el cobro libre otra vez.
   */
  private async settleRequest(walletId: string, requestId: string, auth: ChargeAuthMethod, pinVia?: PinVia): Promise<NoPinSettled | null> {
    const wallet = { id: walletId };
    return this.prisma.acrossVenues(async (tx) => {
      // Cobro único: primero la fila del cobro con tarjeta (el mismo orden que
      // transition()): gana el primero que se paga. Pagado con tarjeta →
      // «Ya está pagado»; cancelado o caducado → ya no está pendiente.
      const link = await tx.walletChargeRequest.findUnique({ where: { id: requestId }, select: { linkedPaymentId: true } });
      const card = link?.linkedPaymentId ? await lockLinkedCard(tx, link.linkedPaymentId) : null;
      if (card) {
        const may = saldoMayPay(card);
        if (may === 'paid') throw alreadyPaid();
        if (may === 'closed') throw requestError('not-pending');
      }
      // blockedAt: saldo bloqueado por el super-admin → no paga (decideAccept).
      const locked = await tx.$queryRaw<
        Array<{
          id: string;
          balanceCents: number;
          status: string;
          blockedAt: Date | null;
          pinLockedAt: Date | null;
          noPinResetAt: Date | null;
        }>
      >`
        SELECT id, "balanceCents", status::text AS status, "blockedAt", "pinLockedAt", "noPinResetAt"
          FROM client_wallets WHERE id = ${wallet.id}::uuid FOR UPDATE
      `;
      const w = locked[0];
      if (!w) throw new NotFoundException('Saldo no encontrado');
      const bound = await tx.walletChargeRequest.updateMany({
        where: { id: requestId, walletId: null, status: 'PENDING' },
        data: { walletId: wallet.id },
      });
      if (bound.count === 0) throw requestError('not-pending');
      const request = await tx.walletChargeRequest.findFirst({ where: { id: requestId, walletId: wallet.id } });
      if (!request) throw new NotFoundException('Cobro no encontrado');
      // Lo que sale del saldo: el importe y la propina que pidió el cliente.
      const tipCents = request.tipCents ?? 0;
      const totalCents = request.amountCents + tipCents;
      const decision = decideAccept({ ...request, amountCents: totalCents }, w, new Date());
      if (!decision.ok) throw requestError(decision.reason);
      // Cobro único: un solo juego de líneas, del que se paga.
      if (card) await moveLinesToSaldo(tx, card.id, request.id);

      const [provider, venue, lines] = await Promise.all([
        tx.user.findUnique({ where: { id: request.requestedByUserId }, select: { role: true, commissionBps: true } }),
        tx.venue.findUnique({
          where: { id: request.tenantId },
          select: { operatorCommissionDefaults: true, nightSettings: true, platformCommissionBps: true },
        }),
        linesOf(tx, { walletChargeIds: [request.id] }),
      ]);
      // NFC sin PIN: con el saldo ya bloqueado, lo gastado sin PIN esta noche
      // (también en los saldos sumados a este) + este cobro, contra el tope.
      const noPin =
        auth === 'nfc_nopin' ? await this.noPinAllowance(tx, w, totalCents, venue?.nightSettings) : null;
      // La propina: entera para la chica que cobra; del local si cobra otra persona.
      const tipToChica = provider?.role === 'OPERATOR';
      // Gastar del saldo no lleva «Comisión del servicio». De lo que se gasta
      // (lo más antiguo primero), lo cargado con ella ya la pagó: el local no
      // paga el % antiguo sobre esa parte; lo cargado sin ella, sí (como
      // siempre). Lo decide cómo se cargó, no el interruptor de ahora.
      const feeSaldoCents = serviceFeeSaldoCents({
        amountCents: request.amountCents,
        tipCents,
        feeSpendCents: serviceFeeSpendCents(await saldoCredits(tx, wallet.id), w.balanceCents, totalCents),
      });
      const consumption = await tx.walletConsumption.create({
        data: {
          tenantId: request.tenantId,
          walletId: wallet.id,
          amountCents: request.amountCents,
          providedByUserId: request.requestedByUserId,
          category: request.category,
          notes: request.serviceName,
          idempotencyKey: `charge-request:${request.id}`,
          authMethod: auth,
          ...(tipCents > 0 ? { tipCents, tipGoesTo: tipToChica ? 'operator' : 'venue' } : {}),
          ...(feeSaldoCents > 0 ? { serviceFeeSaldoCents: feeSaldoCents } : {}),
          // El % de plataforma del local de ahora, fijado en el consumo (como en
          // los cobros): cambiarlo después no cambia lo ya gastado (mapa del
          // dinero y «Liquidación OxioPay»). Va solo sobre lo cargado sin
          // comisión del servicio (serviceFeeSaldoCents fuera).
          ...(venue ? { platformCommissionBps: venue.platformCommissionBps } : {}),
        },
      });
      if (provider?.role === 'OPERATOR') {
        // Por línea (cada sección con su %); un cobro de una sola sección (o
        // de antes de las líneas) da lo de siempre.
        const bpsOf = (category: string) =>
          resolveBpsForOperator({
            category,
            userCommissionBpsOverride: provider.commissionBps,
            venueMap: (venue?.operatorCommissionDefaults ?? null) as Record<string, number> | null,
          });
        const parts = lines.length > 0 ? lines : [{ category: request.category, amountCents: request.amountCents }];
        const commission = lineCommission(parts.map((l) => ({ amountCents: l.amountCents, bps: bpsOf(l.category) })));
        // Sin comisión pero con propina para ella: la propina también le llega.
        if (commission.anyBps || tipCents > 0) {
          await tx.operatorEarning.create({
            data: {
              tenantId: request.tenantId,
              operatorId: request.requestedByUserId,
              consumptionId: consumption.id,
              paymentAmountCents: request.amountCents,
              commissionBps: commission.commissionBps,
              commissionCents: commission.commissionCents,
              ...(tipCents > 0 ? { tipCents } : {}),
            },
          });
        }
      }
      // «Copa con invitación»: la parte de la chica invitada (y la del camarero).
      const invited = lines.filter((l) => l.beneficiaryOperatorId);
      if (invited.length > 0) {
        await insertInvitationEarnings(
          tx,
          request.tenantId,
          { consumptionId: consumption.id },
          invitationEarnings(invited, request.requestedByUserId),
        );
      }
      const newBalance = w.balanceCents - totalCents;
      await tx.clientWallet.update({
        where: { id: wallet.id },
        data: {
          balanceCents: newBalance,
          closeRequestedAt: null,
          ...(newBalance === 0 ? { status: 'DEPLETED' } : {}),
        },
      });
      // Condicional: si la chica lo canceló mientras tanto, no se cobra nada
      // (el error deshace el consumo y el descuento de esta transacción).
      const accepted = await tx.walletChargeRequest.updateMany({
        where: { id: request.id, status: 'PENDING' },
        data: { status: 'ACCEPTED', decidedAt: new Date(), consumptionId: consumption.id },
      });
      if (accepted.count === 0) throw requestError('not-pending');
      // Detalle del pago: con qué se pagó y el saldo antes y después.
      await this.recordSaldoSettled(tx, {
        request: { id: request.id, tenantId: request.tenantId },
        linkedPaymentId: card?.id ?? null,
        auth,
        pinVia,
        beforeCents: w.balanceCents,
        afterCents: newBalance,
      });
      // Cobro único: el cobro con tarjeta ya no se puede autorizar.
      if (card) await cancelCardForSaldo(tx, card, request.id, randomBytes(8).toString('hex'));
      return noPin;
    });
  }

  /**
   * El pago con el saldo, para su detalle: el dispositivo (el del cliente con
   * su Face ID; el del personal o el datáfono con su PIN o su NFC), cómo se
   * autorizó y el saldo antes y después. Cobro único: un `payment.device` en
   * el cobro enlazado. Saldo suelto (sin cobro con tarjeta): en el registro,
   * SIN la IP (audit_events no deja borrar nada).
   */
  private async recordSaldoSettled(
    tx: TransactionalClient,
    s: {
      request: { id: string; tenantId: string };
      linkedPaymentId: string | null;
      auth: ChargeAuthMethod;
      pinVia?: PinVia;
      beforeCents: number;
      afterCents: number;
    },
  ): Promise<void> {
    const ctx = this.cls?.get('ctx');
    const payload = paymentDevicePayload(
      ctx,
      'saldo',
      {
        ...(s.auth === 'passkey' ? { who: 'client' as const } : {}),
        walletChargeId: s.request.id,
        authMethod: s.auth,
        ...(s.pinVia ? { pinVia: s.pinVia } : {}),
        balanceBeforeCents: s.beforeCents,
        balanceAfterCents: s.afterCents,
      },
      { evenWithoutDevice: true },
    )!;
    if (s.linkedPaymentId) {
      await insertPaymentEvent(tx, {
        paymentId: s.linkedPaymentId,
        tenantId: s.request.tenantId,
        eventType: PAYMENT_DEVICE_EVENT,
        payload,
        traceId: ctx?.traceId,
      });
      return;
    }
    // En SQL crudo, como el resto del registro dentro de una transacción del dinero.
    await tx.$executeRaw`
      INSERT INTO audit_events ("tenantId", "actorId", action, "targetType", "targetId", payload, "traceId", "occurredAt")
      VALUES (${s.request.tenantId}::uuid, ${ctx?.userId ?? null}::uuid, ${WALLET_CHARGE_SETTLED_ACTION}, 'WalletChargeRequest',
              ${s.request.id}, ${JSON.stringify(withoutIp(payload))}::jsonb, ${ctx?.traceId ?? null}, now())
    `;
  }

  /**
   * ¿Va sin PIN? 409 PIN_REQUIRED si no (la transacción se deshace y el cobro
   * sigue libre). Un PIN bloqueado por fallos también lo pide: puede que el
   * NFC no lo lleve su dueño.
   */
  private async noPinAllowance(
    tx: RawTx,
    w: { id: string; pinLockedAt: Date | null; noPinResetAt: Date | null },
    amountCents: number,
    rawSettings: unknown,
  ): Promise<NoPinSettled> {
    if (w.pinLockedAt) throw new PinRequiredException('pin_locked');
    const limits = nightSettingsOf(rawSettings);
    const since = noPinWindowStart(new Date(), w.noPinResetAt);
    const spentBeforeCents = await noPinSpentSince(tx, await mergedWalletIds(tx, w.id), since);
    const problem = noPinProblem({ amountCents, spentCents: spentBeforeCents, limits });
    if (problem) throw new PinRequiredException(problem);
    return { spentBeforeCents, nightCapCents: limits.nfcNoPinNightCapCents };
  }

  // ─── Cobro con QR y Face ID (el cliente paga desde su móvil) ─────────────

  /**
   * La chica elige el servicio y enseña un QR. Aún no se sabe de quién es el
   * saldo: lo dice la llave (Face ID) con la que el cliente paga.
   */
  async createQrCharge(actor: Actor, input: QrChargeInput): Promise<QrChargeView> {
    // Local (o su negocio) en pausa: sin cobros del saldo nuevos (423 VENUE_PAUSED).
    // Pago con saldo apagado en Ajustes: 409 PAYMENT_METHOD_DISABLED.
    await this.prisma.asSystem(async (tx) => {
      await assertVenueAcceptsCharges(tx, actor.tenantId);
      await assertVenueAcceptsMethods(tx, actor.tenantId, ['wallet']);
    });
    const { amountCents, category, serviceName, lines, tipCents } = await this.resolveCharge(actor, input);
    const payToken = randomBytes(24).toString('base64url');
    // Cobro, su referencia (C-0001) y sus líneas: todo o nada.
    const request = await this.prisma.asSystem(async (tx) => {
      const ref = await nextChargeRef(tx, actor.tenantId);
      const created = await tx.walletChargeRequest.create({
        data: {
          tenantId: actor.tenantId,
          walletId: null,
          requestedByUserId: actor.userId,
          amountCents,
          category,
          serviceName,
          payToken,
          ref,
          expiresAt: new Date(Date.now() + QR_CHARGE_TTL_MS),
          ...(tipCents > 0 ? { tipCents } : {}),
        },
      });
      await insertChargeLines(tx, actor.tenantId, { walletChargeId: created.id }, lines);
      // Detalle del pago: con qué móvil se creó. Saldo suelto (sin cobro con
      // tarjeta): en el registro, sin la IP (audit_events no deja borrar).
      const device = paymentDevicePayload(this.cls?.get('ctx'), 'create', { walletChargeId: created.id });
      if (device) {
        await tx.$executeRaw`
          INSERT INTO audit_events ("tenantId", "actorId", action, "targetType", "targetId", payload, "traceId", "occurredAt")
          VALUES (${actor.tenantId}::uuid, ${actor.userId}::uuid, ${WALLET_CHARGE_CREATED_ACTION}, 'WalletChargeRequest',
                  ${created.id}, ${JSON.stringify(withoutIp(device))}::jsonb, ${this.cls?.get('ctx')?.traceId ?? null}, now())
        `;
      }
      return created;
    });
    return { ...this.requestView(request, null), payToken };
  }

  /** Lo que ve el cliente al escanear el QR (sin datos de ningún saldo). */
  async qrChargeForClient(payToken: string): Promise<QrChargeClientView> {
    const request = await this.qrRequest(payToken);
    const [venue, requester] = await Promise.all([
      this.prisma.venue.findUnique({ where: { id: request.tenantId }, select: { name: true } }),
      this.prisma.asSystem((tx) =>
        tx.user.findUnique({ where: { id: request.requestedByUserId }, select: { displayName: true } }),
      ),
    ]);
    const status = effectiveRequestStatus(request, new Date());
    const elsewhere = status !== 'ACCEPTED' && (await this.paidByCard(request));
    return {
      status,
      // Lo que paga: el importe y la propina que pidió.
      amountCents: request.amountCents + (request.tipCents ?? 0),
      serviceName: request.serviceName,
      venueName: venue?.name ?? '',
      requestedByName: requester?.displayName ?? null,
      expiresAt: request.expiresAt.toISOString(),
      paidAt: status === 'ACCEPTED' && request.decidedAt ? request.decidedAt.toISOString() : null,
      ...(elsewhere ? { paidElsewhere: true } : {}),
      code: request.linkedPaymentId ? confirmationCode(request.linkedPaymentId) : null,
    };
  }

  /**
   * El cliente pagó con su llave: `walletId` es el saldo de esa llave (ya
   * comprobada). Se ata el cobro a ese saldo y se cobra; si no se puede (no
   * llega, otro grupo…), el cobro vuelve a quedar libre para otro saldo.
   * Ya pagado, la respuesta trae el código del cobro único (el que ve el
   * personal): la página de /s no lo lleva antes de pagar.
   */
  async payQrCharge(payToken: string, walletId: string): Promise<QrChargePaid> {
    const request = await this.qrRequest(payToken);
    await this.bindAndSettle(request, walletId, 'passkey');
    const wallet = await this.prisma.acrossVenues((tx) =>
      tx.clientWallet.findUnique({ where: { id: walletId }, select: { balanceCents: true } }),
    );
    this.logger.log(`Saldo ${walletId}: cobro ${request.id} pagado con su llave (QR)`);
    return {
      amountCents: request.amountCents + (request.tipCents ?? 0),
      balanceCents: wallet?.balanceCents ?? 0,
      code: request.linkedPaymentId ? confirmationCode(request.linkedPaymentId) : null,
    };
  }

  /** Encargado o dueño: cobros con QR que nadie ha pagado aún (cliente sin batería…). */
  async pendingQrCharges(actor: Actor): Promise<PendingQrCharge[]> {
    if (!isManager(actor)) throw new ForbiddenException('Solo el encargado o el dueño');
    const now = new Date();
    const rows = await this.prisma.asSystem((tx) =>
      tx.walletChargeRequest.findMany({
        where: { tenantId: actor.tenantId, walletId: null, payToken: { not: null }, status: 'PENDING', expiresAt: { gt: now } },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
    );
    return this.pendingViews(rows, true);
  }

  /** Para el panel (con el email si no tiene nombre) o para el datáfono (solo el nombre). */
  private async pendingViews(
    rows: Array<{
      id: string;
      amountCents: number;
      tipCents?: number | null;
      serviceName: string | null;
      requestedByUserId: string;
      createdAt: Date;
      expiresAt: Date;
    }>,
    withEmail: boolean,
  ): Promise<PendingQrCharge[]> {
    const users = await this.prisma.asSystem((tx) =>
      tx.user.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.requestedByUserId))] } },
        select: { id: true, displayName: true, email: true },
      }),
    );
    return rows.map((r) => {
      const u = users.find((x) => x.id === r.requestedByUserId);
      return {
        id: r.id,
        // Lo que se cobra del saldo: el importe y la propina.
        amountCents: r.amountCents + (r.tipCents ?? 0),
        serviceName: r.serviceName,
        requestedByName: u?.displayName ?? (withEmail ? u?.email : null) ?? '',
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
      };
    });
  }

  /**
   * Encargado o dueño: el cliente no puede usar su móvil (sin batería, móvil
   * antiguo). Cobra del saldo que él elige un cobro con QR que hizo la chica
   * (la parte de la chica queda como siempre). El cliente no confirma nada: lo
   * firma quien lo aprueba, con su 2FA, y sale en Incidencias y por Telegram.
   */
  async approveWithoutFaceId(actor: Actor, requestId: string, walletId: string, totpCode?: string): Promise<ChargeRequestView> {
    await this.managerWallet(actor, walletId);
    const request = await this.prisma.asSystem((tx) =>
      tx.walletChargeRequest.findFirst({ where: { id: requestId, tenantId: actor.tenantId, payToken: { not: null } } }),
    );
    if (!request) throw new NotFoundException('Cobro no encontrado');
    // Sin el cliente, hacen falta dos personas: la que cobra y otra que aprueba.
    if (request.requestedByUserId === actor.userId) {
      throw new ForbiddenException('Este cobro lo has hecho tú: lo tiene que aprobar otro encargado o el dueño');
    }
    await assertTwoFactorCode(this.totp, actor.userId, totpCode, 'Para cobrar sin que el cliente confirme,', stepUpActions.chargeWithoutFaceId(requestId, walletId));
    await this.bindAndSettle(request, walletId, 'staff');
    await this.audit.log({
      action: 'wallet.charge_without_faceid',
      tenantId: actor.tenantId,
      actorId: actor.userId,
      targetType: 'ClientWallet',
      targetId: walletId,
      payload: { requestId, amountCents: request.amountCents, requestedBy: request.requestedByUserId },
    });
    return this.getRequest(actor, requestId);
  }

  /**
   * «Juntar saldos» desde la página del saldo: lo que dice que el saldo de
   * origen es de quien lo junta es su PIN (el enlace se comparte y se ve).
   * Sin PIN, 403: esa prueba solo la tiene el móvil que pagó la recarga
   * (/pay/<cobro>/merge). Los fallos cuentan como cualquier PIN mal puesto.
   */
  async mergeIntoWithPin(sourceWalletId: string, targetWalletId: string, pin: unknown): Promise<{ balanceCents: number }> {
    const source = await this.prisma.acrossVenues((tx) =>
      tx.clientWallet.findUnique({ where: { id: sourceWalletId }, select: { tenantId: true, pinHash: true } }),
    );
    if (!source) throw new NotFoundException('Saldo no encontrado');
    if (!source.pinHash) throw new ForbiddenException({ message: 'Juntar saldos pide el PIN de esta recarga', code: 'MERGE_PROOF_REQUIRED' });
    if (typeof pin !== 'string' || !/^[0-9]{4}$/.test(pin)) throw new BadRequestException({ message: 'El PIN son 4 cifras', code: 'PIN_FORMAT' });
    await this.checkPin(sourceWalletId, pin, { tenantId: source.tenantId, userId: null });
    return this.mergeInto(sourceWalletId, targetWalletId);
  }

  /**
   * Recarga nueva sumada al saldo que el cliente ya tenía (lo dice su llave).
   * El saldo nuevo queda a 0 y apuntando al otro (sus pagos siguen siendo
   * suyos, para devolverlos a la tarjeta).
   */
  async mergeInto(sourceWalletId: string, targetWalletId: string): Promise<{ balanceCents: number }> {
    if (sourceWalletId === targetWalletId) throw mergeError('Es el mismo saldo');
    const result = await this.prisma.acrossVenues(async (tx) => {
      // 1) Los pagos a medias de la recarga, bloqueados ANTES que los saldos
      //    (el mismo orden que el cobro: pago → saldo, sin abrazos mortales).
      //    Un cobro que se está confirmando ahora mismo termina antes (y lo
      //    que suma ya cuenta aquí); uno que llegue después espera a que esto
      //    acabe. ORPHAN también: la conciliación aún lo puede dar por pagado.
      const open = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM payments
         WHERE "walletId" = ${sourceWalletId}::uuid
           AND status IN ('CREATED', 'AWAITING_CAPTURE', 'AUTHORIZING', 'ORPHAN')
         FOR UPDATE
      `;
      if (open.length > 0) throw mergeError('Esta recarga tiene otro pago a medias: inténtalo en unos minutos', 'MERGE_BUSY');
      // 2) Los dos saldos, siempre en el mismo orden: dos fusiones a la vez no se bloquean entre sí.
      const ids = [sourceWalletId, targetWalletId].sort();
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          tenantId: string;
          walletGroup: string | null;
          balanceCents: number;
          status: string;
          shortCode: string | null;
          mergedIntoId: string | null;
          blockedAt: Date | null;
        }>
      >`
        SELECT id, "tenantId", "walletGroup", "balanceCents", status::text AS status, "shortCode", "mergedIntoId", "blockedAt"
          FROM client_wallets WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE
      `;
      const source = rows.find((r) => r.id === sourceWalletId);
      const target = rows.find((r) => r.id === targetWalletId);
      if (!source || !target) throw new NotFoundException('Saldo no encontrado');
      // Bloqueado por el super-admin (no paga, decideAccept): tampoco se junta.
      // Si no, fusionar movería su dinero a un saldo sin bloquear (o al revés).
      if (source.blockedAt || target.blockedAt) throw mergeError(MERGE_BLOCKED, 'WALLET_BLOCKED');
      if (!sameWalletGroup(target, { id: source.tenantId, walletGroup: source.walletGroup })) {
        throw mergeError('Ese saldo es de otro local: no se pueden juntar');
      }
      if (source.status !== 'ACTIVE' || source.balanceCents <= 0 || source.mergedIntoId) {
        throw mergeError('Esta recarga ya no se puede sumar');
      }
      // Un saldo ya sumado a otro no recibe dinero: el del cliente es aquel.
      if ((target.status !== 'ACTIVE' && target.status !== 'DEPLETED') || target.mergedIntoId) {
        throw mergeError('Tu saldo está cerrado', 'WALLET_CLOSED');
      }
      const keys = await tx.walletPasskey.count({ where: { walletId: sourceWalletId } });
      if (keys > 0) throw mergeError('Esta recarga ya tiene su propio Face ID');
      // A 0 (DEPLETED) se reabre; si su código lo tiene ya otro cliente, con uno nuevo.
      await tx.clientWallet.update({
        where: { id: targetWalletId },
        data: { balanceCents: { increment: source.balanceCents }, ...(await reopenData(tx, target)) },
      });
      // Una recarga pendiente de asignar (cobrada sin el NFC del cliente) deja de estarlo.
      await tx.clientWallet.update({
        where: { id: sourceWalletId },
        data: { balanceCents: 0, status: 'DEPLETED', mergedIntoId: targetWalletId, pendingAssignAt: null },
      });
      // Su ficha va con el dinero: si no, al pagar diría «no tiene saldo» y el stock la vería libre.
      await moveWalletCards(tx, { walletId: sourceWalletId, venueId: source.tenantId }, targetWalletId);
      return { moved: source.balanceCents, tenantId: source.tenantId, balanceCents: target.balanceCents + source.balanceCents };
    });
    await this.audit.log({
      action: 'wallet.merged',
      tenantId: result.tenantId,
      targetType: 'ClientWallet',
      targetId: targetWalletId,
      payload: { from: sourceWalletId, amountCents: result.moved },
    });
    if (result.moved >= MERGE_ALERT_CENTS) {
      await this.audit.log({
        action: 'wallet.merged_large',
        tenantId: result.tenantId,
        targetType: 'ClientWallet',
        targetId: targetWalletId,
        payload: { from: sourceWalletId, amountCents: result.moved },
      });
    }
    return { balanceCents: result.balanceCents };
  }

  // ─── PIN del cliente (pagar sin sacar el móvil) ─────────────────────────

  /**
   * El cliente no saca el móvil: la chica pone su código y él teclea su PIN
   * en el móvil de ella. Se paga el mismo cobro del QR (no queda otro colgado).
   */
  async payQrChargeWithPin(actor: Actor, requestId: string, input: StaffWalletRef & { pin: string }): Promise<ChargeRequestView> {
    const request = await this.prisma.asSystem((tx) =>
      tx.walletChargeRequest.findFirst({ where: { id: requestId, tenantId: actor.tenantId, payToken: { not: null } } }),
    );
    if (!request) throw new NotFoundException('Cobro no encontrado');
    const manager = isManager(actor);
    if (request.requestedByUserId !== actor.userId && !manager) {
      throw new ForbiddenException('Este cobro lo ha hecho otra persona');
    }
    // Con la ficha NFC apagada en Ajustes no se paga con ella (sí con el código).
    if ('card' in input) await this.assertMethods(actor.tenantId, ['nfc']);
    // Que no se gaste un intento de PIN en un cobro que ya no se puede pagar.
    if (effectiveRequestStatus(request, new Date()) !== 'PENDING' || request.walletId) {
      throw await this.notPendingError(request);
    }
    // Con el cobro: si la ficha es una copia, la sospecha queda apuntada en él (detalle del pago).
    const wallet = await this.walletByStaffRef(actor.tenantId, 'card' in input ? { ...input, requestId: request.id } : input);
    // Un PIN que puso el encargado sin el cliente: ni él cobra con ese PIN ni
    // aprueba un cobro suyo (hacen falta dos personas, como sin Face ID).
    if (wallet.pinSetById && (wallet.pinSetById === actor.userId || wallet.pinSetById === request.requestedByUserId)) {
      throw new ForbiddenException('Este PIN lo pusiste tú: el cobro lo tiene que hacer otra persona');
    }
    await this.checkPin(wallet.id, input.pin, actor);
    const via = pinViaOf(input);
    await this.bindAndSettle(request, wallet.id, 'pin', via);
    if ('card' in input) await this.touchCard(wallet.id, input);
    this.logger.log(`Saldo ${wallet.id}: cobro ${request.id} pagado con PIN (${via}, ${actor.userId})`);
    return this.getRequest(actor, requestId);
  }

  /**
   * La chica escaneó el pase de Google Wallet del cliente para este cobro
   * (/c/<token>, comprobado con su firma como en el datáfono): de quién es y
   * si le llega, sin enseñar lo que tiene ni su código. No gasta intentos de PIN.
   */
  async checkPassForCharge(actor: Actor, requestId: string, walletToken: string): Promise<StaffPassCheck> {
    const request = await this.prisma.asSystem((tx) =>
      tx.walletChargeRequest.findFirst({ where: { id: requestId, tenantId: actor.tenantId, payToken: { not: null } } }),
    );
    if (!request) throw new NotFoundException('Cobro no encontrado');
    if (request.requestedByUserId !== actor.userId && !isManager(actor)) {
      throw new ForbiddenException('Este cobro lo ha hecho otra persona');
    }
    await this.assertPayable(request);
    const wallet = await this.walletByLinkToken(actor.tenantId, walletToken, { chargeOnly: true });
    if (wallet.blockedAt) throw requestError('blocked');
    return {
      codeHint: codeHintOf(wallet.shortCode),
      hasPin: wallet.pinHash !== null,
      pinLocked: wallet.pinLockedAt !== null,
      ownPin: pinSetByStaffHere(wallet, actor, request),
      enough: wallet.balanceCents >= request.amountCents,
    };
  }

  /** Código, ficha o (solo el de cobrar) el QR del pase. */
  private async walletByStaffRef(venueId: string, ref: StaffWalletRef) {
    if ('walletToken' in ref) return this.walletByLinkToken(venueId, ref.walletToken, { chargeOnly: true });
    return this.walletByRef(venueId, ref);
  }

  /**
   * NFC sin PIN: la chica (o el camarero) acerca el NFC del cliente y, si no
   * pasa del máximo ni del tope de la noche del local, se cobra ya. Si no,
   * 409 PIN_REQUIRED y el mismo cobro se paga con su PIN. Solo con el NFC
   * comprobado (su número de serie, como el guardado): una copia no paga.
   */
  async payQrChargeWithCard(
    actor: Actor,
    requestId: string,
    input: { card: string; uid?: string | null },
  ): Promise<ChargeRequestView> {
    const request = await this.prisma.asSystem((tx) =>
      tx.walletChargeRequest.findFirst({ where: { id: requestId, tenantId: actor.tenantId, payToken: { not: null } } }),
    );
    if (!request) throw new NotFoundException('Cobro no encontrado');
    if (request.requestedByUserId !== actor.userId && !isManager(actor)) {
      throw new ForbiddenException('Este cobro lo ha hecho otra persona');
    }
    await this.assertMethods(actor.tenantId, ['nfc']);
    if (effectiveRequestStatus(request, new Date()) !== 'PENDING' || request.walletId) throw await this.notPendingError(request);
    const wallet = await this.noPinCardWallet(actor.tenantId, { ...input, requestId: request.id });
    const noPin = await this.bindAndSettle(request, wallet.id, 'nfc_nopin');
    await this.touchCard(wallet.id, input);
    await this.logNoPinCharge(request, wallet.id, noPin, { tenantId: actor.tenantId, actorId: actor.userId });
    this.logger.log(`Saldo ${wallet.id}: cobro ${request.id} pagado con el NFC sin PIN (${actor.userId})`);
    return this.getRequest(actor, requestId);
  }

  /** El saldo del NFC acercado, si se puede pagar sin PIN con él (si no, 409 PIN_REQUIRED). */
  private async noPinCardWallet(venueId: string, input: CardRefInput) {
    const { card, wallet } = await this.cardWithWallet(venueId, input);
    const problem = noPinCardProblem(card, input.uid ? normalizeWalletCardUid(input.uid) : null);
    if (problem) throw new PinRequiredException(problem);
    return wallet;
  }

  /** Cada cobro sin PIN, en el registro: cuánto, cuánto llevaba esa noche y el tope. */
  private async logNoPinCharge(
    request: { id: string; amountCents: number },
    walletId: string,
    noPin: NoPinSettled | null,
    who: { tenantId: string; actorId?: string; terminalId?: string },
  ): Promise<void> {
    await this.audit.log({
      action: 'wallet.charge_nfc_nopin',
      tenantId: who.tenantId,
      ...(who.actorId ? { actorId: who.actorId } : {}),
      targetType: 'ClientWallet',
      targetId: walletId,
      payload: {
        requestId: request.id,
        amountCents: request.amountCents,
        spentBeforeCents: noPin?.spentBeforeCents ?? null,
        nightCapCents: noPin?.nightCapCents ?? null,
        ...(who.terminalId ? { terminalId: who.terminalId } : {}),
      },
    });
  }

  /**
   * Ficha usada para pagar: cuándo. El número de serie NO se fija aquí: solo
   * al darla o al ponerla en el stock (si una copia llegara antes que la
   * original, la original pasaría luego por «copia»).
   */
  private async touchCard(walletId: string, input: { card: string }): Promise<void> {
    await this.prisma.acrossVenues((tx) =>
      tx.walletCard.updateMany({ where: { token: input.card, walletId }, data: { lastUsedAt: new Date() } }),
    );
  }

  // ─── Datáfono del local (Authorization: Device, sin persona) ────────────
  //
  // El datáfono lee de qué saldo es (ficha NFC, el QR del pase del cliente o
  // su código) y el cliente teclea su PIN en él para pagar un cobro con QR que
  // hizo una chica: el mismo cobro, con la parte de la chica de siempre. Solo
  // cobros de su local y saldos de su grupo; los mismos 5 PIN fallidos
  // bloquean el saldo. Nadie sabe quién sostiene el datáfono: un PIN que puso
  // el personal (pinSetById) no vale aquí (la regla de las dos personas).

  /** Los cobros con QR del local sin pagar, para elegir uno en el datáfono. */
  async pendingQrChargesForTerminal(terminal: TerminalActor): Promise<PendingQrCharge[]> {
    const rows = await this.prisma.asSystem((tx) =>
      tx.walletChargeRequest.findMany({
        where: {
          tenantId: terminal.tenantId,
          walletId: null,
          payToken: { not: null },
          status: 'PENDING',
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
    );
    return this.pendingViews(rows, false);
  }

  /** El datáfono escaneó el QR del cobro en el móvil de la chica (/s/<payToken>). */
  async qrChargeForTerminal(terminal: TerminalActor, payToken: string): Promise<PendingQrCharge> {
    const request = await this.prisma.asSystem((tx) =>
      tx.walletChargeRequest.findFirst({ where: { payToken, tenantId: terminal.tenantId } }),
    );
    if (!request) throw new NotFoundException('Este QR no es de un cobro de este local');
    await this.assertPayable(request);
    const [view] = await this.pendingViews([request], false);
    if (!view) throw new NotFoundException('Cobro no encontrado');
    return view;
  }

  /**
   * ¿Se pagó? Tras un corte en el PIN el datáfono pregunta antes de decir nada
   * (sin el saldo que le queda: eso solo lo ve quien tecleó el PIN bueno).
   */
  async qrChargeStatusForTerminal(terminal: TerminalActor, requestId: string): Promise<ChargeRequestView> {
    const request = await this.prisma.asSystem((tx) =>
      tx.walletChargeRequest.findFirst({
        where: { id: requestId, tenantId: terminal.tenantId, payToken: { not: null } },
      }),
    );
    if (!request) throw new NotFoundException('Cobro no encontrado');
    return this.requestView(request, null);
  }

  /** De quién es el saldo y si le llega, sin enseñar lo que tiene. No gasta intentos de PIN. */
  async checkWalletForTerminal(
    terminal: TerminalActor,
    requestId: string,
    ref: TerminalWalletRef,
  ): Promise<TerminalWalletCheck> {
    const request = await this.terminalRequest(terminal, requestId);
    // Ficha NFC apagada en Ajustes (Formas de cobro): tampoco en el datáfono.
    if ('card' in ref) await this.assertMethods(terminal.tenantId, ['nfc']);
    const wallet = await this.walletByTerminalRef(terminal.tenantId, ref);
    if (wallet.blockedAt) throw requestError('blocked');
    const enough = wallet.balanceCents >= request.amountCents;
    return {
      codeHint: codeHintOf(wallet.shortCode),
      hasPin: wallet.pinHash !== null,
      pinLocked: wallet.pinLockedAt !== null,
      pinByStaff: wallet.pinSetById !== null,
      enough,
      noPin: 'card' in ref && enough && (await this.noPinLikely(terminal.tenantId, ref, wallet, request.amountCents)),
    };
  }

  /** ¿Iría sin PIN? Lo mismo que mira el cobro, sin bloquear nada (el cobro lo vuelve a mirar). */
  private async noPinLikely(
    venueId: string,
    ref: { card: string; uid?: string | null },
    wallet: { id: string; pinLockedAt: Date | null; noPinResetAt: Date | null },
    amountCents: number,
  ): Promise<boolean> {
    if (wallet.pinLockedAt) return false;
    const { card } = await this.cardWithWallet(venueId, ref);
    if (noPinCardProblem(card, ref.uid ? normalizeWalletCardUid(ref.uid) : null)) return false;
    const [venue, spentCents] = await Promise.all([
      this.prisma.venue.findUnique({ where: { id: venueId }, select: { nightSettings: true } }),
      this.prisma.acrossVenues(async (tx) =>
        noPinSpentSince(tx, await mergedWalletIds(tx, wallet.id), noPinWindowStart(new Date(), wallet.noPinResetAt)),
      ),
    ]);
    return noPinProblem({ amountCents, spentCents, limits: nightSettingsOf(venue?.nightSettings) }) === null;
  }

  /** El cliente tecleó su PIN en el datáfono: se cobra el cobro de su saldo. */
  async payQrChargeFromTerminal(
    terminal: TerminalActor,
    requestId: string,
    input: TerminalWalletRef & { pin: string },
  ): Promise<ChargeRequestView> {
    const request = await this.terminalRequest(terminal, requestId);
    if ('card' in input) await this.assertMethods(terminal.tenantId, ['nfc']);
    const wallet = await this.walletByTerminalRef(terminal.tenantId, input);
    if (wallet.pinSetById) {
      throw new ForbiddenException('Este PIN lo puso el personal: este cobro se hace desde la app, con otra persona');
    }
    const who = { tenantId: terminal.tenantId, userId: null, terminalId: terminal.terminalId };
    await this.checkPin(wallet.id, input.pin, who);
    const via = pinViaOf(input);
    await this.bindAndSettle(request, wallet.id, 'pin', via);
    if ('card' in input) await this.touchCard(wallet.id, input);
    await this.audit.log({
      action: 'wallet.pin_charge_terminal',
      tenantId: terminal.tenantId,
      targetType: 'ClientWallet',
      targetId: wallet.id,
      payload: { requestId, amountCents: request.amountCents, terminalId: terminal.terminalId, via },
    });
    this.logger.log(`Saldo ${wallet.id}: cobro ${request.id} pagado con PIN en el datáfono ${terminal.terminalId} (${via})`);
    return this.terminalChargeView(request, wallet.id);
  }

  /**
   * NFC sin PIN en el datáfono: el cliente acerca su NFC al lector y, hasta el
   * máximo y el tope de la noche del local, se cobra sin PIN (si no, 409
   * PIN_REQUIRED y se sigue con su PIN). Siempre con su número de serie.
   */
  async payQrChargeFromTerminalWithCard(
    terminal: TerminalActor,
    requestId: string,
    input: { card: string; uid?: string | null },
  ): Promise<ChargeRequestView> {
    const request = await this.terminalRequest(terminal, requestId);
    await this.assertMethods(terminal.tenantId, ['nfc']);
    if (!(input.uid && normalizeWalletCardUid(input.uid))) throw new BadRequestException(TERMINAL_CARD_NEEDS_UID);
    const wallet = await this.noPinCardWallet(terminal.tenantId, { ...input, requestId: request.id });
    const noPin = await this.bindAndSettle(request, wallet.id, 'nfc_nopin');
    await this.touchCard(wallet.id, input);
    await this.logNoPinCharge(request, wallet.id, noPin, { tenantId: terminal.tenantId, terminalId: terminal.terminalId });
    this.logger.log(`Saldo ${wallet.id}: cobro ${request.id} pagado con el NFC sin PIN en el datáfono ${terminal.terminalId}`);
    return this.terminalChargeView(request, wallet.id);
  }

  /** El cobro tras pagarlo en el datáfono, con lo que le queda (solo si se pagó). */
  private async terminalChargeView(
    request: { id: string; status: string; amountCents: number; serviceName: string | null; expiresAt: Date },
    walletId: string,
  ): Promise<ChargeRequestView> {
    const [fresh, after] = await Promise.all([
      this.prisma.asSystem((tx) => tx.walletChargeRequest.findFirst({ where: { id: request.id } })),
      this.prisma.acrossVenues((tx) =>
        tx.clientWallet.findUnique({ where: { id: walletId }, select: { balanceCents: true } }),
      ),
    ]);
    const settled = fresh ?? request;
    return this.requestView(settled, settled.status === 'ACCEPTED' ? (after?.balanceCents ?? null) : null);
  }

  /** Un cobro con QR de este local que aún se puede pagar (si no, ni se gasta un intento de PIN). */
  private async terminalRequest(terminal: TerminalActor, requestId: string) {
    const request = await this.prisma.asSystem((tx) =>
      tx.walletChargeRequest.findFirst({
        where: { id: requestId, tenantId: terminal.tenantId, payToken: { not: null } },
      }),
    );
    if (!request) throw new NotFoundException('Cobro no encontrado');
    await this.assertPayable(request);
    return request;
  }

  private async assertPayable(request: {
    status: string;
    expiresAt: Date;
    walletId: string | null;
    linkedPaymentId?: string | null;
  }): Promise<void> {
    const status = effectiveRequestStatus(request, new Date());
    if (status === 'EXPIRED') throw requestError('expired');
    if (status !== 'PENDING' || request.walletId) throw await this.notPendingError(request);
  }

  /**
   * En el datáfono la ficha se lee siempre con su lector NFC: sin número de
   * serie (p. ej. su enlace pasado a QR y leído con la cámara) no vale, que es
   * como se colaría una copia.
   */
  private async walletByTerminalRef(venueId: string, ref: TerminalWalletRef) {
    if ('walletToken' in ref) return this.walletByLinkToken(venueId, ref.walletToken);
    if ('card' in ref && !(ref.uid && normalizeWalletCardUid(ref.uid))) {
      throw new BadRequestException(TERMINAL_CARD_NEEDS_UID);
    }
    return this.walletByRef(venueId, ref);
  }

  /**
   * El QR del pase de Google Wallet: el token solo para cobrar (/c/<token>,
   * pass-charge-token.ts) o, en pases de antes que aún no se han puesto al
   * día, el enlace /w/<token> del saldo. Su saldo si sigue abierto y vale en
   * este local. Una recarga sumada a otro saldo lleva a ese otro (el pase
   * viejo sigue valiendo).
   */
  private async walletByLinkToken(venueId: string, token: string, opts: { chargeOnly?: boolean } = {}) {
    const [first, venue] = await Promise.all([
      this.walletOfPassToken(token, opts.chargeOnly === true),
      this.prisma.venue.findUnique({ where: { id: venueId }, select: { walletGroup: true } }),
    ]);
    let wallet = first;
    for (let hops = 0; wallet?.mergedIntoId && hops < MAX_MERGE_HOPS; hops += 1) {
      const nextId: string = wallet.mergedIntoId;
      wallet = await this.prisma.acrossVenues((tx) => tx.clientWallet.findUnique({ where: { id: nextId } }));
    }
    if (
      !wallet ||
      wallet.status !== 'ACTIVE' ||
      !sameWalletGroup(wallet, { id: venueId, walletGroup: venue?.walletGroup ?? null })
    ) {
      throw new NotFoundException('Este pase no tiene saldo en este local');
    }
    return wallet;
  }

  /**
   * El saldo del QR del pase: el token de cobro (comprobado con su enlace
   * actual) o, salvo `chargeOnly` (el móvil del personal), el enlace /w.
   */
  private async walletOfPassToken(token: string, chargeOnly = false) {
    const chargeWalletId = passChargeWalletId(token);
    if (!chargeWalletId) {
      if (chargeOnly) return null;
      return this.prisma.acrossVenues((tx) => tx.clientWallet.findUnique({ where: { qrToken: token } }));
    }
    const wallet = await this.prisma.acrossVenues((tx) => tx.clientWallet.findUnique({ where: { id: chargeWalletId } }));
    // Firma mala o enlace cambiado (pase viejo apagado): no es de nadie.
    return wallet && passChargeTokenValid(passChargeSecret(), token, wallet) ? wallet : null;
  }

  // ─── Recepción en el datáfono (Authorization: Device) ───────────────────
  //
  // El datáfono actúa como el local: no hay persona. Lo que hace queda con su
  // terminalId (recarga, ficha dada y auditoría) y el PIN que teclea el
  // cliente en él es suyo (pinSetById null). Lo que en la app del personal
  // pide «la recarga es tuya y de hace menos de 15 min», aquí pide que la
  // recarga la cobrara ESTE datáfono hace menos de 15 min.

  /**
   * La ficha acercada en la recepción (datáfono o móvil del personal): de qué
   * saldo es, sin su saldo ni su nombre. Para recargar vale también un saldo
   * ya gastado (la recarga lo reabre).
   */
  async lookupCardForReception(venueId: string, input: { card: string; uid?: string | null }): Promise<ReceptionCardView> {
    return this.lookupForReception(venueId, input);
  }

  /** Lo mismo con el NFC o con el código del saldo («Recargar saldo» en Inicio). */
  async lookupForReception(
    venueId: string,
    input: { card: string; uid?: string | null } | { code: string },
  ): Promise<ReceptionCardView> {
    if ('card' in input) await this.assertMethods(venueId, ['nfc']);
    const wallet = await topUpTarget(this.prisma, venueId, input);
    return {
      walletId: wallet.id,
      codeHint: codeHintOf(wallet.shortCode),
      hasPin: wallet.pinHash !== null,
      isHomeVenue: wallet.tenantId === venueId,
    };
  }

  /** El saldo recién recargado en este datáfono: su código (el cliente lo apunta), saldo, PIN y ficha. */
  async receptionWallet(terminal: TerminalActor, walletId: string): Promise<ReceptionWalletView> {
    const wallet = await this.terminalFreshWallet(terminal, walletId);
    const cards = await this.prisma.acrossVenues((tx) => tx.walletCard.count({ where: { walletId, status: { in: ISSUED_CARD_STATUSES } } }));
    return {
      walletId: wallet.id,
      code: formatWalletCode(wallet.shortCode ?? ''),
      balanceCents: wallet.balanceCents,
      hasPin: wallet.pinHash !== null,
      hasCard: cards > 0,
    };
  }

  /** Dar la ficha acercada al saldo recién recargado en este datáfono. */
  async linkCardFromTerminal(
    terminal: TerminalActor,
    input: { walletId: string; card: string; uid?: string | null },
  ): Promise<ReceptionWalletView> {
    if (!isWalletCardToken(input.card)) throw new BadRequestException('Esta ficha no es nuestra: grábala otra vez');
    await this.assertMethods(terminal.tenantId, ['nfc']);
    await this.terminalFreshWallet(terminal, input.walletId);
    const uid = input.uid ? normalizeWalletCardUid(input.uid) : null;
    const by: CardBy = { userId: null, terminalId: terminal.terminalId };
    const replaced = await attachCard(this.prisma, { walletId: input.walletId, venueId: terminal.tenantId, card: input.card, uid, by });
    await this.audit.log({
      action: 'wallet.card_linked',
      tenantId: terminal.tenantId,
      targetType: 'ClientWallet',
      targetId: input.walletId,
      payload: { replacedCards: replaced, withUid: uid !== null, terminalId: terminal.terminalId },
    });
    return this.receptionWallet(terminal, input.walletId);
  }

  /** El cliente elige su PIN en el teclado del datáfono (es suyo: pinSetById null). */
  async setPinFromTerminal(terminal: TerminalActor, walletId: string, pin: string): Promise<ReceptionWalletView> {
    await this.terminalFreshWallet(terminal, walletId);
    await this.storeFirstPin(walletId, pin, null);
    await this.audit.log({
      action: 'wallet.pin_set',
      tenantId: terminal.tenantId,
      targetType: 'ClientWallet',
      targetId: walletId,
      payload: { where: 'terminal', terminalId: terminal.terminalId },
    });
    return this.receptionWallet(terminal, walletId);
  }

  /** Un saldo del grupo cuya primera recarga cobró este datáfono hace menos de 15 min. */
  private async terminalFreshWallet(terminal: TerminalActor, walletId: string) {
    const [wallet, venue] = await Promise.all([
      this.prisma.acrossVenues((tx) => tx.clientWallet.findUnique({ where: { id: walletId } })),
      this.prisma.venue.findUnique({ where: { id: terminal.tenantId }, select: { walletGroup: true } }),
    ]);
    if (
      !wallet ||
      !sameWalletGroup(wallet, { id: terminal.tenantId, walletGroup: venue?.walletGroup ?? null }) ||
      !(await this.isFreshTopUp(walletId, { terminalId: terminal.terminalId }))
    ) {
      throw new NotFoundException('Saldo no encontrado: la ficha y el PIN se dan justo al recargar en este datáfono');
    }
    return wallet;
  }

  // ─── Ficha NFC (dice de qué saldo es; el cliente pone su PIN) ──────────
  //
  // Límite conocido (iPhone): Safari no lee NFC; el propio iPhone abre el
  // enlace grabado en la ficha y la app recibe solo {card} (el código), sin el
  // número de serie (uid). Así, con un iPhone no se puede ver si la ficha es
  // una copia (alguien que copió el enlace en otra ficha o lo tiene a mano):
  // la comprobación del uid solo vale cuando la lee un Android (o cuando la
  // ficha ya tiene uid y el móvil lo manda). Por eso la ficha nunca basta para
  // pagar: siempre hace falta el PIN del cliente (5 fallos → bloqueado, ver
  // checkPin), igual que con el código. Una ficha perdida se bloquea (blockCard).
  //
  // Las fichas (wallet_cards) no tienen local ni RLS: una ficha se graba en
  // blanco y luego se da a un saldo de cualquier local del grupo. El acceso va
  // siempre por el saldo: walletByCard y linkCard comprueban que el saldo vale
  // en el local de quien la usa (sameWalletGroup) y las lecturas van con
  // acrossVenues; blockCard pasa por managerWallet (mismo grupo).

  /** La chica acerca la ficha: su saldo (si vale en este local). */
  async lookupCard(venueId: string, input: { card: string; uid?: string | null }): Promise<WalletLookup> {
    await this.assertMethods(venueId, ['nfc']);
    return this.lookupWallet(venueId, await this.walletByCard(venueId, input));
  }

  /** 409 PAYMENT_METHOD_DISABLED si el local apagó esa forma de cobro (Ajustes). */
  private async assertMethods(venueId: string, needed: Array<'wallet' | 'nfc'>): Promise<void> {
    await this.prisma.asSystem((tx) => assertVenueAcceptsMethods(tx, venueId, needed));
  }

  /**
   * Código nuevo para grabar en una ficha vacía. Lo crea el servidor (al azar,
   * 128 bits): solo las fichas grabadas así se pueden dar a un saldo.
   */
  async issueCard(actor: Actor): Promise<{ card: string }> {
    await this.assertMethods(actor.tenantId, ['nfc']);
    return { card: await createCardToken(this.prisma, actor.tenantId, { userId: actor.userId }) };
  }

  /**
   * Dar ficha a un saldo: la chica de la primera recarga (en sus 15 min) o el
   * encargado. Una ficha de un saldo ya gastado o cerrado se reutiliza; la de
   * otro cliente con saldo, no. Una ficha por saldo: la anterior se suelta.
   */
  async linkCard(actor: Actor, input: { code: string; card: string; uid?: string | null }): Promise<WalletLookup> {
    if (!isWalletCardToken(input.card)) throw new BadRequestException('Esta ficha no es nuestra: grábala otra vez');
    await this.assertMethods(actor.tenantId, ['nfc']);
    const uid = input.uid ? normalizeWalletCardUid(input.uid) : null;
    const wallet = await this.walletByCode(actor.tenantId, input.code);
    const manager = isManager(actor);
    if (!manager && !(await this.freshTopUpBy(wallet.id, actor.userId))) {
      throw new UnprocessableEntityException('La ficha se da justo al recargar (o con el encargado)');
    }
    const replaced = await attachCard(this.prisma, {
      walletId: wallet.id,
      venueId: actor.tenantId,
      card: input.card,
      uid,
      by: { userId: actor.userId },
    });
    await this.audit.log({
      action: 'wallet.card_linked',
      tenantId: actor.tenantId,
      actorId: actor.userId,
      targetType: 'ClientWallet',
      targetId: wallet.id,
      payload: { replacedCards: replaced, withUid: uid !== null },
    });
    return this.lookupWallet(actor.tenantId, wallet);
  }

  /** Encargado o dueño: ficha perdida → bloqueada. El saldo sigue (Face ID, código + PIN). */
  async blockCard(actor: Actor, walletId: string): Promise<{ ok: true }> {
    await this.managerWallet(actor, walletId);
    const res = await this.prisma.acrossVenues(async (tx) => {
      const cards = await tx.walletCard.findMany({
        where: { walletId, status: { in: ISSUED_CARD_STATUSES } },
        select: { id: true },
      });
      if (cards.length === 0) return { count: 0 };
      const now = new Date();
      await tx.walletCard.updateMany({
        where: { id: { in: cards.map((c) => c.id) } },
        data: { status: 'BLOCKED', blockedAt: now },
      });
      await recordCardEvents(tx, cards.map((c) => ({ cardId: c.id, walletId, kind: 'BLOCKED' as const })), {
        venueId: actor.tenantId,
        by: { userId: actor.userId },
        now,
      });
      return { count: cards.length };
    });
    if (res.count === 0) throw new ConflictException('Este saldo no tiene ficha');
    await this.audit.log({
      action: 'wallet.card_blocked',
      tenantId: actor.tenantId,
      actorId: actor.userId,
      targetType: 'ClientWallet',
      targetId: walletId,
      payload: {},
    });
    return { ok: true };
  }

  private async walletByRef(venueId: string, ref: WalletRef) {
    return 'card' in ref ? this.walletByCard(venueId, ref) : this.walletByCode(venueId, ref.code);
  }

  /** La ficha → su saldo: activa, con saldo abierto y del grupo de este local. */
  private async walletByCard(venueId: string, input: CardRefInput) {
    return (await this.cardWithWallet(venueId, input)).wallet;
  }

  /** La ficha (dada, y no una copia) y su saldo abierto del grupo de este local. */
  private async cardWithWallet(venueId: string, input: CardRefInput) {
    const card = isWalletCardToken(input.card)
      ? await this.prisma.acrossVenues((tx) => tx.walletCard.findUnique({ where: { token: input.card } }))
      : null;
    if (!card || !isIssuedCard(card) || !card.walletId) {
      throw new NotFoundException('Esta ficha no tiene saldo: dásela al cliente al recargar');
    }
    const uid = input.uid ? normalizeWalletCardUid(input.uid) : null;
    // Sin uid (la lee un iPhone) no se puede comprobar que sea la original:
    // vale solo para saber de qué saldo es; pagar sigue pidiendo su PIN.
    if (card.uid && uid && card.uid !== uid) {
      this.logger.warn(`Ficha ${card.id}: número de serie distinto (¿copia?)`);
      // Alguien lo está intentando: que lo vea el encargado, no solo el registro técnico.
      await this.audit.log({
        action: 'wallet.card_copy_suspected',
        tenantId: venueId,
        targetType: 'ClientWallet',
        targetId: card.walletId,
        // El cobro que se intentaba pagar: su detalle lo enseña como señal.
        payload: { cardId: card.id, ...(input.requestId ? { requestId: input.requestId } : {}) },
      });
      throw new ConflictException('Esta ficha no es la original (¿copiada?): avisa al encargado');
    }
    const walletId = card.walletId;
    const [wallet, venue] = await Promise.all([
      this.prisma.acrossVenues((tx) => tx.clientWallet.findUnique({ where: { id: walletId } })),
      this.prisma.venue.findUnique({ where: { id: venueId }, select: { walletGroup: true } }),
    ]);
    if (
      !wallet ||
      wallet.status !== 'ACTIVE' ||
      !sameWalletGroup(wallet, { id: venueId, walletGroup: venue?.walletGroup ?? null })
    ) {
      throw new NotFoundException('Esta ficha no tiene saldo en este local');
    }
    return { card, wallet };
  }

  /**
   * El cliente elige su PIN en el móvil de la chica: solo la que le hizo la
   * recarga que creó el saldo, en los 15 min siguientes (el cliente está
   * delante). Después, el encargado (p. ej. lo olvidó) — y entonces él no
   * puede cobrar con ese PIN.
   */
  async setPin(actor: Actor, input: { code: string; pin: string }): Promise<WalletLookup> {
    const wallet = await this.walletByCode(actor.tenantId, input.code);
    const fresh = await this.freshTopUpBy(wallet.id, actor.userId);
    if (!fresh && !isManager(actor)) {
      throw new UnprocessableEntityException('Este saldo no tiene PIN: que lo elija con el encargado (o en su móvil al recargar)');
    }
    await this.storeFirstPin(wallet.id, input.pin, fresh ? null : actor.userId);
    await this.audit.log({
      action: 'wallet.pin_set',
      tenantId: actor.tenantId,
      actorId: actor.userId,
      targetType: 'ClientWallet',
      targetId: wallet.id,
      payload: { where: 'staff-device', role: actor.role, afterTopUp: fresh },
    });
    return this.lookup(actor.tenantId, input.code);
  }

  /** El cliente elige su PIN en su propio móvil, en "Pagado" de la recarga. */
  async setPinFromPayer(walletId: string, pin: string): Promise<void> {
    const wallet = await this.prisma.acrossVenues((tx) =>
      tx.clientWallet.findUnique({ where: { id: walletId }, select: { tenantId: true } }),
    );
    if (!wallet) throw new NotFoundException('Saldo no encontrado');
    await this.storeFirstPin(walletId, pin, null);
    await this.audit.log({
      action: 'wallet.pin_set',
      tenantId: wallet.tenantId,
      targetType: 'ClientWallet',
      targetId: walletId,
      payload: { where: 'client-phone' },
    });
  }

  /**
   * El primer PIN con el QR de activación (/w/a/<token>, M-2): `inTx` gasta
   * el QR en la MISMA transacción que guarda el PIN (si algo falla, ni PIN ni
   * QR gastado). Lo elige el cliente en su móvil.
   */
  async setFirstPinWithActivation(
    walletId: string,
    pin: string,
    inTx: (tx: TransactionalClient) => Promise<void>,
  ): Promise<void> {
    const wallet = await this.prisma.acrossVenues((tx) =>
      tx.clientWallet.findUnique({ where: { id: walletId }, select: { tenantId: true } }),
    );
    if (!wallet) throw new NotFoundException('Saldo no encontrado');
    await this.storeFirstPin(walletId, pin, null, inTx);
    await this.audit.log({
      action: 'wallet.pin_set',
      tenantId: wallet.tenantId,
      targetType: 'ClientWallet',
      targetId: walletId,
      payload: { where: 'activation-link' },
    });
  }

  /** Encargado o dueño: tras 5 PIN fallidos, vuelve a dejar probar. */
  async unlockPin(actor: Actor, walletId: string): Promise<{ ok: true }> {
    await this.managerWallet(actor, walletId);
    await this.prisma.acrossVenues((tx) =>
      tx.clientWallet.update({ where: { id: walletId }, data: { pinFails: 0, pinLockedAt: null } }),
    );
    await this.audit.log({
      action: 'wallet.pin_unlocked',
      tenantId: actor.tenantId,
      actorId: actor.userId,
      targetType: 'ClientWallet',
      targetId: walletId,
      payload: {},
    });
    return { ok: true };
  }

  /** Encargado o dueño, con su 2FA: el cliente olvidó su PIN → se borra y elige otro. */
  async resetPin(actor: Actor, walletId: string, totpCode?: string): Promise<{ ok: true }> {
    await this.managerWallet(actor, walletId);
    await assertTwoFactorCode(this.totp, actor.userId, totpCode, 'Para borrar el PIN de un cliente,', stepUpActions.resetPin(walletId));
    await this.prisma.acrossVenues((tx) =>
      tx.clientWallet.update({
        where: { id: walletId },
        data: { pinHash: null, pinFails: 0, pinLockedAt: null, pinFailedAt: null, pinSetById: null },
      }),
    );
    await this.audit.log({
      action: 'wallet.pin_reset',
      tenantId: actor.tenantId,
      actorId: actor.userId,
      targetType: 'ClientWallet',
      targetId: walletId,
      payload: {},
    });
    return { ok: true };
  }

  /** El PIN que teclea el cliente en SU móvil (QR de activación de un saldo que ya lo tenía). */
  async checkClientPin(walletId: string, tenantId: string, pin: string): Promise<void> {
    await this.checkPin(walletId, pin, { tenantId, userId: null });
  }

  /**
   * Comprueba el PIN con el saldo bloqueado (dos intentos a la vez no se
   * saltan el contador). Los fallos se guardan aunque el cobro no siga.
   */
  private async checkPin(
    walletId: string,
    pin: string,
    actor: { tenantId: string; userId: string | null; terminalId?: string },
  ): Promise<void> {
    const pepper = pinPepper();
    const outcome = await this.prisma.acrossVenues(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ pinHash: string | null; pinFails: number; pinLockedAt: Date | null; pinFailedAt: Date | null }>
      >`
        SELECT "pinHash", "pinFails", "pinLockedAt", "pinFailedAt" FROM client_wallets WHERE id = ${walletId}::uuid FOR UPDATE
      `;
      const w = rows[0];
      if (!w) return { kind: 'missing' as const };
      if (!w.pinHash) return { kind: 'no-pin' as const };
      if (w.pinLockedAt) return { kind: 'locked' as const };
      if (await verifyPin(pin, w.pinHash, pepper)) {
        // PIN bueno: lo gastado con el NFC sin PIN esta noche vuelve a contar desde aquí.
        await tx.clientWallet.update({
          where: { id: walletId },
          data: { pinFails: 0, pinFailedAt: null, noPinResetAt: new Date() },
        });
        return { kind: 'ok' as const };
      }
      // Fallos de hace más de 12 h no cuentan (un despiste otra noche no bloquea).
      const stale = !w.pinFailedAt || Date.now() - w.pinFailedAt.getTime() > PIN_FAILS_EXPIRE_MS;
      const fails = (stale ? 0 : w.pinFails) + 1;
      const lock = fails >= PIN_MAX_FAILS;
      await tx.clientWallet.update({
        where: { id: walletId },
        data: { pinFails: fails, pinFailedAt: new Date(), ...(lock ? { pinLockedAt: new Date() } : {}) },
      });
      return { kind: lock ? ('now-locked' as const) : ('wrong' as const), left: PIN_MAX_FAILS - fails };
    });
    if (outcome.kind === 'wrong' || outcome.kind === 'now-locked') {
      // Quién tecleó el PIN mal: si alguien bloquea saldos ajenos, se ve.
      await this.audit.log({
        action: outcome.kind === 'now-locked' ? 'wallet.pin_locked' : 'wallet.pin_failed',
        tenantId: actor.tenantId,
        actorId: actor.userId,
        targetType: 'ClientWallet',
        targetId: walletId,
        // Desde un datáfono no hay persona: queda cuál fue.
        payload: { attemptsLeft: outcome.left, ...(actor.terminalId ? { terminalId: actor.terminalId } : {}) },
      });
    }
    switch (outcome.kind) {
      case 'ok':
        return;
      case 'missing':
        throw new NotFoundException('Saldo no encontrado');
      case 'no-pin':
        throw new ConflictException('El cliente aún no tiene PIN: que pague con Face ID o lo elija con el encargado');
      // 422 (no 403): la app enseña el texto tal cual ("No tienes permiso" confundiría).
      case 'locked':
        throw new UnprocessableEntityException({ message: 'Saldo bloqueado por PIN fallado: avisa al encargado para desbloquearlo', code: 'PIN_LOCKED' });
      case 'now-locked':
        this.logger.warn(`Saldo ${walletId}: bloqueado tras ${PIN_MAX_FAILS} PIN fallidos`);
        throw new UnprocessableEntityException({ message: 'PIN incorrecto. Saldo bloqueado: avisa al encargado para desbloquearlo', code: 'PIN_LOCKED' });
      case 'wrong':
        throw new UnprocessableEntityException({
          message: `PIN incorrecto. ${outcome.left === 1 ? 'Queda 1 intento' : `Quedan ${outcome.left} intentos`}`,
          code: 'PIN_WRONG',
        });
    }
  }

  /**
   * Guarda el primer PIN (si ya hay uno, solo el encargado lo puede borrar).
   * `setById`: el encargado que lo pone sin el cliente delante (null si lo
   * eligió el cliente: en su móvil o con la chica justo tras recargar).
   */
  private async storeFirstPin(
    walletId: string,
    pin: string,
    setById: string | null,
    inTx?: (tx: TransactionalClient) => Promise<void>,
  ): Promise<void> {
    const problem = pinProblem(pin);
    if (problem) throw new BadRequestException({ message: PIN_PROBLEM_TEXT[problem], code: `PIN_${problem.toUpperCase()}` });
    const pinHash = await hashPin(pin, pinPepper());
    await this.prisma.acrossVenues(async (tx) => {
      if (inTx) await inTx(tx);
      const res = await tx.clientWallet.updateMany({
        where: { id: walletId, pinHash: null },
        data: { pinHash, pinFails: 0, pinFailedAt: null, pinLockedAt: null, pinSetById: setById },
      });
      // Dentro de la transacción: si ya tenía PIN, lo que hizo inTx (gastar el QR) se deshace.
      if (res.count === 0) throw new ConflictException({ message: 'Este saldo ya tiene PIN', code: 'PIN_EXISTS' });
    });
  }

  /**
   * La recarga que creó este saldo la cobró esta persona hace menos de 15 min
   * (el cliente está delante). Solo la primera: recargar un saldo viejo no
   * vuelve a abrir la puerta.
   */
  private async freshTopUpBy(walletId: string, userId: string): Promise<boolean> {
    return this.isFreshTopUp(walletId, { userId });
  }

  /** La primera recarga del saldo (tarjeta o efectivo) es de esta persona o datáfono, hace menos de 15 min. */
  private async isFreshTopUp(walletId: string, by: TopUpBy): Promise<boolean> {
    return isFreshTopUpBy(await firstTopUp(this.prisma, walletId), by);
  }

  /**
   * Ata un cobro con QR a un saldo y lo cobra (todo o nada: si falla, el cobro
   * sigue libre). `auth`: cómo lo autorizó el cliente (queda en el consumo).
   */
  private async bindAndSettle(
    request: { id: string; tenantId: string; status: string; expiresAt: Date; walletId: string | null; linkedPaymentId?: string | null },
    walletId: string,
    auth: ChargeAuthMethod,
    pinVia?: PinVia,
  ): Promise<NoPinSettled | null> {
    if (effectiveRequestStatus(request, new Date()) !== 'PENDING' || request.walletId) {
      throw await this.notPendingError(request);
    }
    // Un cobro hecho antes de la pausa tampoco se cobra mientras dure (423),
    // ni con el pago con saldo apagado en Ajustes (409).
    await this.prisma.asSystem(async (tx) => {
      await assertVenueAcceptsCharges(tx, request.tenantId);
      await assertVenueAcceptsMethods(tx, request.tenantId, ['wallet']);
    });
    const [wallet, venue] = await Promise.all([
      this.prisma.acrossVenues((tx) =>
        tx.clientWallet.findUnique({ where: { id: walletId }, select: { tenantId: true, walletGroup: true } }),
      ),
      this.prisma.venue.findUnique({ where: { id: request.tenantId }, select: { walletGroup: true } }),
    ]);
    if (!wallet || !sameWalletGroup(wallet, { id: request.tenantId, walletGroup: venue?.walletGroup ?? null })) {
      throw new ConflictException({ message: 'Tu saldo no vale en este local', code: 'CHARGE_OTHER_VENUE' });
    }
    return this.settleRequest(walletId, request.id, auth, pinVia);
  }

  /**
   * Por qué no se puede pagar un cobro que ya no está pendiente: si es el
   * saldo de un cobro único y la tarjeta ya lo pagó, «Ya está pagado»
   * (ALREADY_PAID); si no, «Este cobro ya no está pendiente».
   */
  private async notPendingError(request: { linkedPaymentId?: string | null }): Promise<ConflictException> {
    return (await this.paidByCard(request)) ? alreadyPaid() : requestError('not-pending');
  }

  private async qrRequest(payToken: string) {
    const request = await this.prisma.acrossVenues((tx) => tx.walletChargeRequest.findUnique({ where: { payToken } }));
    if (!request) throw new NotFoundException('Cobro no encontrado');
    return request;
  }

  private async managerWallet(actor: Actor, walletId: string): Promise<void> {
    if (!isManager(actor)) {
      throw new ForbiddenException('Solo el encargado o el dueño');
    }
    const venue = await this.prisma.venue.findUnique({ where: { id: actor.tenantId }, select: { walletGroup: true } });
    const wallet = await this.prisma.acrossVenues((tx) =>
      tx.clientWallet.findUnique({ where: { id: walletId }, select: { tenantId: true, walletGroup: true } }),
    );
    if (!wallet || !sameWalletGroup(wallet, { id: actor.tenantId, walletGroup: venue?.walletGroup ?? null })) {
      throw new NotFoundException('Saldo no encontrado');
    }
  }

  /** "Me voy": el cliente pide que le devuelvan el saldo (sale en Incidencias). */
  async requestClose(qrToken: string): Promise<ClientWalletState> {
    const wallet = await this.walletByToken(qrToken);
    if (wallet.balanceCents <= 0) throw new ConflictException({ message: 'No te queda saldo que devolver', code: 'NOTHING_TO_REFUND' });
    const res = await this.prisma.asSystem((tx) =>
      tx.clientWallet.updateMany({
        where: { id: wallet.id, status: 'ACTIVE', closeRequestedAt: null },
        data: { closeRequestedAt: new Date() },
      }),
    );
    if (res.count > 0) {
      await this.audit.log({
        action: 'wallet.close_requested',
        tenantId: wallet.tenantId,
        targetType: 'ClientWallet',
        targetId: wallet.id,
        payload: { balanceCents: wallet.balanceCents },
      });
    }
    return this.clientState(qrToken);
  }

  // ─── Devolver el saldo (encargado o dueño) ─────────────────────────────

  /**
   * Devuelve el saldo (y lo cierra si queda a 0).
   *  - CASH: en efectivo en el local (dueño o encargado), en una transacción.
   *    Solo lo que entró en efectivo y sin llegar a 1.000 € en 24 h
   *    (wallet-cash-limits): lo que entró con tarjeta sigue en el saldo y lo
   *    devuelve el dueño «A la tarjeta». El encargado, desde el umbral del
   *    local, con su código 2FA.
   *  - CARD: ya hecho en el portal de BBVA (solo el dueño): se reparte entre
   *    las recargas y se apunta como devolución de cada una (payoutCard). Como
   *    mucho el saldo menos el efectivo que sigue en él (ese, en efectivo).
   */
  /**
   * El PIN del cliente para la salida de recepción (ReceptionPayoutService):
   * el de siempre, con su contador de fallos y quién lo tecleó.
   */
  async checkPinForPayout(actor: Actor, walletId: string, pin: string): Promise<void> {
    await this.checkPin(walletId, pin, actor);
  }

  /**
   * «Ver mi saldo con mi PIN» desde la ficha (B7): el mismo PIN y el mismo
   * contador de fallos (5 → bloqueado), sin persona (lo teclea el cliente en
   * su móvil). No paga nada: solo deja ver el saldo un rato.
   */
  async checkPinForCardView(walletId: string, tenantId: string, pin: string): Promise<void> {
    await this.checkPin(walletId, pin, { tenantId, userId: null });
  }

  /**
   * Lo que haría «Devolver saldo» ahora, sin tocar nada: en efectivo, lo que
   * entró en efectivo sin llegar a 1.000 € en 24 h; a la tarjeta, el resto; y
   * lo que hoy no puede salir en efectivo. El panel lo enseña antes de
   * confirmar y lo manda de vuelta (expectedAmountCents): si al confirmar ya
   * es otra cifra, 409 en vez de apuntar otra cosa.
   */
  async payoutPreview(actor: Actor, walletId: string): Promise<WalletPayoutPreview> {
    if (!isManager(actor)) throw new ForbiddenException('Solo el encargado o el dueño');
    const venue = await this.prisma.venue.findUnique({ where: { id: actor.tenantId }, select: { walletGroup: true } });
    return this.prisma.acrossVenues(async (tx) => {
      const w = await tx.clientWallet.findUnique({ where: { id: walletId } });
      if (!w || !sameWalletGroup(w, { id: actor.tenantId, walletGroup: venue?.walletGroup ?? null })) {
        throw new NotFoundException('Saldo no encontrado');
      }
      const balanceCents = w.status === 'ACTIVE' ? Math.max(0, w.balanceCents) : 0;
      const pending = await tx.walletPayout.findFirst({ where: { walletId, status: 'PENDING' } });
      if (pending) {
        // payoutCash no paga nada hasta terminarla; «A la tarjeta» la retoma con su importe.
        return { balanceCents, cashOutCents: 0, cardRefundCents: pending.amountCents, cashLaterCents: 0, pendingCardCents: pending.amountCents };
      }
      const amounts = balanceCents > 0
        ? payoutAmounts(balanceCents, await walletCash(tx, walletId))
        : { cashOutCents: 0, cardRefundCents: 0, cashLaterCents: 0 };
      return { balanceCents, ...amounts, pendingCardCents: null };
    });
  }

  async payout(actor: Actor, walletId: string, input: WalletPayoutInput): Promise<WalletPayoutResult> {
    if (input.method === 'CARD' && actor.role !== 'OWNER') {
      throw new ForbiddenException('La devolución a la tarjeta la registra el dueño (se hace en el portal de BBVA)');
    }
    if (input.method === 'CASH' && !isManager(actor)) {
      throw new ForbiddenException('Devolver en efectivo lo hace el encargado');
    }
    // El efectivo sale solo con el encargado o el dueño (ni la chica ni el
    // camarero, tampoco el de recepción): ver assertCanHandleCash para las recargas.
    const venue = await this.prisma.venue.findUnique({
      where: { id: actor.tenantId },
      select: { walletGroup: true, refundApprovalThresholdCents: true },
    });
    const wallet = await this.prisma.acrossVenues((tx) => tx.clientWallet.findUnique({ where: { id: walletId } }));
    if (!wallet || !sameWalletGroup(wallet, { id: actor.tenantId, walletGroup: venue?.walletGroup ?? null })) {
      throw new NotFoundException('Saldo no encontrado');
    }
    // Las recargas (y sus devoluciones) son del local donde se cargó el saldo.
    if (input.method === 'CARD' && wallet.tenantId !== actor.tenantId) {
      throw new ConflictException('La devolución a la tarjeta se apunta desde el local donde el cliente cargó el saldo');
    }
    // Sin el "Me voy" del cliente, solo el dueño puede devolver su saldo.
    if (actor.role === 'MANAGER' && !wallet.closeRequestedAt) {
      throw new ForbiddenException('El cliente tiene que pulsar «Me voy» en su página de saldo (o que lo haga el dueño)');
    }
    // El dueño devuelve sin que el cliente lo pida ni esté delante: su 2FA, siempre.
    if (actor.role === 'OWNER') await assertTwoFactorCode(this.totp, actor.userId, input.totpCode, 'Para devolver un saldo,', stepUpActions.walletPayout(walletId));
    return input.method === 'CASH'
      ? this.payoutCash(actor, walletId, input, venue?.refundApprovalThresholdCents, wallet.closeRequestedAt)
      : this.payoutCard(actor, walletId, input);
  }

  /**
   * En efectivo: en una sola transacción se apunta la devolución y el saldo
   * baja (se cierra si queda a 0). Con el saldo bloqueado se mira lo que se
   * puede devolver en efectivo y el 2FA del encargado (lo que se devuelve es
   * lo que hay ahora, no lo que vio el panel). Con una devolución a la tarjeta
   * a medias, nada: primero se termina aquella. Lo que recepción dejó para el
   * encargado (más de 100 €, su tope de la noche…), con su 2FA aunque sea poco.
   */
  private async payoutCash(
    actor: Actor,
    walletId: string,
    input: Omit<WalletPayoutInput, 'method'>,
    thresholdCents: number | undefined,
    closeRequestedAt: Date | null = null,
  ): Promise<WalletPayoutResult> {
    const { amount, remaining, twoFactor } = await this.prisma.acrossVenues(async (tx) => {
      const w = await lockWallet(tx, walletId);
      const halfDone = await tx.walletPayout.findFirst({ where: { walletId, status: 'PENDING' } });
      if (halfDone) {
        throw new ConflictException(
          `Hay una devolución a la tarjeta de ${eur(halfDone.amountCents)} a medias: que el dueño vuelva a pulsar «A la tarjeta» para terminarla`,
        );
      }
      if (!w || w.status !== 'ACTIVE' || w.balanceCents <= 0) {
        throw new ConflictException('Este saldo no tiene nada que devolver');
      }
      const cash = await walletCash(tx, walletId);
      const cap = cashPayoutCapCents(w.balanceCents, cash);
      if (cap <= 0) throw new ConflictException(cashPayoutRefusal(w.balanceCents, cash));
      assertExpectedPayout(input.expectedAmountCents, cap);
      const fromReception = actor.role === 'MANAGER' && (await receptionAskedManager(tx, walletId, closeRequestedAt));
      if (fromReception) {
        await assertTwoFactorCode(
          this.totp,
          actor.userId,
          input.totpCode,
          `Devolver ${eur(cap)} en efectivo: recepción lo dejó para el encargado,`,
          stepUpActions.walletPayout(walletId),
        );
      }
      const asked = fromReception || (await assertManagerTwoFactor(
        this.totp,
        actor,
        cap,
        cashApprovalThreshold(thresholdCents),
        input.totpCode,
        `Devolver ${eur(cap)} en efectivo`,
        stepUpActions.walletPayout(walletId),
      ));
      const left = w.balanceCents - cap;
      // Lo que entró con tarjeta sigue en el saldo (abierto, con su «Me voy») para el dueño.
      await tx.clientWallet.update({
        where: { id: walletId },
        data: left === 0 ? { balanceCents: 0, status: 'REFUNDED' } : { balanceCents: left },
      });
      // «Me voy»: el cliente devuelve la ficha y vuelve al stock (si no, el encargado la marca perdida).
      if (left === 0) await returnWalletCards(tx, walletId, actor.tenantId, { userId: actor.userId });
      await tx.walletPayout.create({
        data: {
          tenantId: actor.tenantId,
          walletId,
          amountCents: cap,
          method: 'CASH',
          status: 'DONE',
          bankReference: input.bankReference ?? null,
          note: input.note ?? null,
          paidByUserId: actor.userId,
        },
      });
      return { amount: cap, remaining: left, twoFactor: asked };
    });
    await this.audit.log({
      action: 'wallet.payout',
      tenantId: actor.tenantId,
      actorId: actor.userId,
      targetType: 'ClientWallet',
      targetId: walletId,
      payload: { method: 'CASH', refundedCents: amount, remainingCents: remaining, twoFactor },
    });
    return remaining > 0
      ? { refundedCents: amount, method: 'CASH', remainingCents: remaining }
      : { refundedCents: amount, method: 'CASH' };
  }

  /**
   * A la tarjeta (ya hecha en el portal de BBVA), en pasos que se pueden retomar:
   *  1) el saldo pasa a una devolución PENDING (la wallet sigue abierta, a 0: no se gasta);
   *  2) se apunta en cada recarga lo que falte (lo ya apuntado por esta devolución no se repite);
   *  3) en una transacción, la devolución queda hecha por lo apuntado, lo que no se pudo
   *     apuntar vuelve al saldo y la wallet se cierra si se quedó a 0.
   * Si el proceso se cae entre 1 y 3, la PENDING guarda el importe y, al volver a
   * pulsar (pasados unos minutos), se retoma donde se quedó.
   */
  private async payoutCard(
    actor: Actor,
    walletId: string,
    input: Omit<WalletPayoutInput, 'method'>,
  ): Promise<WalletPayoutResult> {
    const pending = await this.claimCardPayout(actor, walletId, input);
    let outcome = { refunded: 0, remaining: pending.amountCents };
    try {
      const already = await this.prisma.acrossVenues((tx) => registeredSince(tx, walletId, pending.createdAt));
      const missing = pending.amountCents - already;
      if (missing > 0) await this.refundToCard(actor, walletId, missing, pending.bankReference ?? undefined);
    } finally {
      // Siempre (aunque algo falle): lo apuntado sale del saldo y lo que no, vuelve.
      outcome = await this.completeCardPayout(walletId, pending);
      await this.audit.log({
        action: 'wallet.payout',
        tenantId: actor.tenantId,
        actorId: actor.userId,
        targetType: 'ClientWallet',
        targetId: walletId,
        payload: {
          method: 'CARD',
          refundedCents: outcome.refunded,
          remainingCents: outcome.remaining,
          payoutId: pending.id,
          resumed: pending.resumed,
        },
      });
    }
    if (outcome.remaining > 0) {
      throw new ConflictException(
        `Se apuntaron ${eur(outcome.refunded)}; quedan ${eur(outcome.remaining)} que las recargas no cubren. Devuélvelos en efectivo.`,
      );
    }
    return { refundedCents: outcome.refunded, method: 'CARD' };
  }

  /**
   * Paso 1: el saldo pasa a una devolución PENDING, o se retoma la que quedó a
   * medias. Con la wallet bloqueada: dos clics a la vez no la apuntan dos veces.
   */
  private async claimCardPayout(
    actor: Actor,
    walletId: string,
    input: Omit<WalletPayoutInput, 'method'>,
  ): Promise<{ id: string; amountCents: number; createdAt: Date; bankReference: string | null; resumed: boolean }> {
    return this.prisma.acrossVenues(async (tx) => {
      const w = await lockWallet(tx, walletId);
      if (!w) throw new NotFoundException('Saldo no encontrado');
      const open = await tx.walletPayout.findFirst({ where: { walletId, status: 'PENDING' } });
      if (open) {
        if (open.claimedAt && Date.now() - open.claimedAt.getTime() < PAYOUT_CLAIM_MS) {
          throw new ConflictException('Ya se está apuntando la devolución de este saldo: espera un momento');
        }
        assertExpectedPayout(input.expectedAmountCents, open.amountCents);
        // Se quedó a medias (el proceso se cayó): se retoma con lo que ya se apuntó.
        await tx.walletPayout.update({ where: { id: open.id }, data: { claimedAt: new Date() } });
        this.logger.warn(`Saldo ${walletId}: se retoma la devolución a la tarjeta ${open.id} que quedó a medias`);
        return { id: open.id, amountCents: open.amountCents, createdAt: open.createdAt, bankReference: open.bankReference, resumed: true };
      }
      if (w.status !== 'ACTIVE' || w.balanceCents <= 0) throw new ConflictException('Este saldo no tiene nada que devolver');
      // El efectivo que sigue en el saldo no sale por el banco: se devuelve en efectivo.
      const amount = cardRefundCapCents(w.balanceCents, await walletCash(tx, walletId));
      if (amount <= 0) {
        throw new ConflictException('Este saldo entró en efectivo: se devuelve en efectivo, no a la tarjeta');
      }
      assertExpectedPayout(input.expectedAmountCents, amount);
      await tx.clientWallet.update({ where: { id: walletId }, data: { balanceCents: w.balanceCents - amount } });
      const created = await tx.walletPayout.create({
        data: {
          tenantId: actor.tenantId,
          walletId,
          amountCents: amount,
          method: 'CARD',
          status: 'PENDING',
          claimedAt: new Date(),
          bankReference: input.bankReference ?? null,
          note: input.note ?? null,
          paidByUserId: actor.userId,
        },
      });
      return { id: created.id, amountCents: created.amountCents, createdAt: created.createdAt, bankReference: created.bankReference, resumed: false };
    });
  }

  /**
   * Paso 3, en una transacción: la devolución queda hecha por lo que de verdad
   * se apuntó en el banco (las devoluciones, no lo que creímos), lo demás
   * vuelve al saldo (que se reabre) y, si se quedó a 0, se cierra.
   */
  private async completeCardPayout(
    walletId: string,
    pending: { id: string; createdAt: Date },
  ): Promise<{ refunded: number; remaining: number }> {
    return this.prisma.acrossVenues(async (tx) => {
      const w = await lockWallet(tx, walletId);
      const row = await tx.walletPayout.findFirst({ where: { id: pending.id } });
      if (!w || !row) throw new NotFoundException('Saldo no encontrado');
      if (row.status === 'DONE') return { refunded: row.amountCents, remaining: 0 };
      const refunded = Math.min(await registeredSince(tx, walletId, pending.createdAt), row.amountCents);
      const remaining = row.amountCents - refunded;
      if (refunded > 0) {
        await tx.walletPayout.update({ where: { id: row.id }, data: { status: 'DONE', amountCents: refunded, claimedAt: null } });
      } else {
        await tx.walletPayout.delete({ where: { id: row.id } });
      }
      const balance = w.balanceCents + remaining;
      const status = balance > 0 ? await reopenData(tx, w) : w.status === 'ACTIVE' ? { status: 'REFUNDED' as const } : {};
      await tx.clientWallet.update({ where: { id: walletId }, data: { balanceCents: { increment: remaining }, ...status } });
      // Devuelto del todo: su ficha vuelve al stock del local que lo devuelve.
      if (balance === 0) await returnWalletCards(tx, walletId, row.tenantId, { userId: row.paidByUserId });
      return { refunded, remaining };
    });
  }

  /**
   * El cliente perdió el enlace de su saldo (pagó en otro navegador, borró la
   * página…). El dueño le da uno nuevo y el viejo deja de valer: quien lo
   * hubiera visto ya no puede aceptar cobros con él. Lo que se enseña al
   * cliente (`path`) es un QR de activación de un solo uso (/w/a/<token>, 10
   * min, M-2): con él activa Face ID (o elige PIN) en su móvil y va a su
   * saldo. El enlace permanente nuevo no sale en la pantalla del dueño.
   */
  async relinkWithCode(actor: Actor, walletId: string, totpCode: string | undefined): Promise<{ path: string }> {
    if (actor.role !== 'OWNER') {
      throw new ForbiddenException('Un enlace nuevo del saldo solo lo da el dueño');
    }
    await assertTwoFactorCode(this.totp, actor.userId, totpCode, 'Para dar un enlace nuevo del saldo,', stepUpActions.relink(walletId));
    return this.relink(actor, walletId);
  }

  async relink(actor: Actor, walletId: string): Promise<{ path: string }> {
    if (actor.role !== 'OWNER') {
      throw new ForbiddenException('Un enlace nuevo del saldo solo lo da el dueño');
    }
    const venue = await this.prisma.venue.findUnique({ where: { id: actor.tenantId }, select: { walletGroup: true } });
    const wallet = await this.prisma.acrossVenues((tx) => tx.clientWallet.findUnique({ where: { id: walletId } }));
    if (!wallet || !sameWalletGroup(wallet, { id: actor.tenantId, walletGroup: venue?.walletGroup ?? null })) {
      throw new NotFoundException('Saldo no encontrado');
    }
    if (wallet.status !== 'ACTIVE') throw new ConflictException('Este saldo ya está cerrado');
    const qrToken = newWalletToken();
    // Enlace nuevo = el cliente perdió el suyo o el móvil: su llave (Face ID)
    // se borra y la activa otra vez desde el enlace nuevo.
    const { removedKeys, activation } = await this.prisma.acrossVenues(async (tx) => {
      await tx.clientWallet.update({ where: { id: walletId }, data: { qrToken } });
      const removed = (await tx.walletPasskey.deleteMany({ where: { walletId } })).count;
      // Sin llave ya: el primer Face ID (o PIN) del enlace nuevo, con un QR de un solo uso.
      const issued = await issueActivationToken(tx, { walletId, venueId: actor.tenantId, issuedById: actor.userId, via: 'relink' });
      return { removedKeys: removed, activation: issued };
    });
    await this.audit.log({
      action: 'wallet.relinked',
      tenantId: actor.tenantId,
      actorId: actor.userId,
      targetType: 'ClientWallet',
      targetId: walletId,
      payload: { amountCents: wallet.balanceCents, balanceCents: wallet.balanceCents, removedPasskeys: removedKeys, activationExpiresAt: activation.expiresAt.toISOString() },
    });
    await this.audit.log({
      action: 'wallet.activation_link',
      tenantId: actor.tenantId,
      actorId: actor.userId,
      targetType: 'ClientWallet',
      targetId: walletId,
      payload: { via: 'relink', expiresAt: activation.expiresAt.toISOString() },
    });
    return { path: activationPath(activation.token) };
  }

  private async refundToCard(actor: Actor, walletId: string, amountCents: number, bankReference?: string): Promise<number> {
    const topUps = await this.cardTopUps(actor, walletId);
    const plan = allocateCardRefund(
      topUps.map((t) => ({ paymentId: t.id, availableAmountCents: t.availableAmountCents })),
      amountCents,
    );
    const refunds = this.refunds();
    let done = 0;
    for (const part of plan) {
      try {
        await refunds.registerBankRefund(
          {
            paymentId: part.paymentId,
            amountCents: part.amountCents,
            reason: 'Devolución del saldo al cliente',
            bankReference,
          },
          actor,
          { walletPayout: true },
        );
        done += part.amountCents;
      } catch (err) {
        this.logger.error(`Devolución del saldo ${walletId}: falló una recarga (${(err as Error).message})`);
        break;
      }
    }
    return done;
  }

  /**
   * Las recargas que se pueden devolver a la tarjeta: las de este saldo y las
   * de los saldos que se sumaron a él (su dinero está aquí), la más reciente
   * primero. Solo las de este local: las devoluciones las apunta el local de
   * la recarga (una recarga sumada desde otro local del grupo se devuelve en
   * efectivo).
   */
  private async cardTopUps(actor: Actor, walletId: string): Promise<Array<{ id: string; availableAmountCents: number }>> {
    return this.prisma.acrossVenues(async (tx) => {
      const walletIds = await mergedWalletIds(tx, walletId);
      return tx.payment.findMany({
        where: {
          walletId: { in: walletIds },
          tenantId: actor.tenantId,
          status: { in: ['AUTHORIZED', 'PARTIALLY_REFUNDED'] },
          availableAmountCents: { gt: 0 },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, availableAmountCents: true },
      });
    });
  }

  private refunds(): RefundsService {
    return this.moduleRef.get<RefundsService>(REFUNDS_SERVICE, { strict: false });
  }

  // ─── Auxiliares ────────────────────────────────────────────────────────

  private async walletByCode(venueId: string, rawCode: string) {
    const code = normalizeWalletCode(rawCode);
    if (code.length !== 6) throw new BadRequestException('El código del cliente tiene 6 letras o números');
    const [wallet, venue] = await Promise.all([
      this.prisma.acrossVenues((tx) => tx.clientWallet.findFirst({ where: { shortCode: code, status: 'ACTIVE' } })),
      this.prisma.venue.findUnique({ where: { id: venueId }, select: { walletGroup: true } }),
    ]);
    if (!wallet || !sameWalletGroup(wallet, { id: venueId, walletGroup: venue?.walletGroup ?? null })) {
      throw new NotFoundException('No hay ningún saldo con ese código en este local');
    }
    // Bloqueado por el super-admin: ni recargarlo (con tarjeta) ni pagar con él desde la app.
    if (wallet.blockedAt) throw new WalletBlockedException();
    return wallet;
  }

  /** El saldo de este enlace (o de esta recarga), para su Face ID. */
  async walletRefByToken(qrToken: string): Promise<{ id: string; shortCode: string | null }> {
    const w = await this.walletByToken(qrToken);
    return { id: w.id, shortCode: w.shortCode };
  }

  /** El saldo nuevo de una recarga (por su id), para sumarlo a otro o activar Face ID. */
  async walletRefById(walletId: string): Promise<{ id: string; shortCode: string | null }> {
    const w = await this.prisma.acrossVenues((tx) =>
      tx.clientWallet.findUnique({ where: { id: walletId }, select: { id: true, shortCode: true } }),
    );
    if (!w) throw new NotFoundException('Saldo no encontrado');
    return w;
  }

  private async walletByToken(qrToken: string) {
    const wallet = await this.prisma.asSystem((tx) => tx.clientWallet.findUnique({ where: { qrToken } }));
    if (!wallet) throw new NotFoundException({ message: 'Saldo no encontrado', code: 'WALLET_NOT_FOUND' });
    return wallet;
  }

  private requestView(
    r: {
      id: string;
      status: string;
      amountCents: number;
      tipCents?: number | null;
      serviceName: string | null;
      expiresAt: Date;
      ref?: number | null;
    },
    newBalanceCents: number | null,
  ): ChargeRequestView {
    return {
      id: r.id,
      ref: formatChargeRef(r.ref),
      status: effectiveRequestStatus(r, new Date()),
      amountCents: r.amountCents,
      tipCents: r.tipCents ?? 0,
      serviceName: r.serviceName,
      expiresAt: r.expiresAt.toISOString(),
      newBalanceCents,
    };
  }
}

/** En el datáfono, una ficha sin su número de serie (leída por cámara) no vale. */
const TERMINAL_CARD_NEEDS_UID = 'Acerca la ficha al lector del datáfono (sin leerla por NFC no vale: podría ser una copia)';

/** Saldos sumados uno a otro que se siguen como mucho desde un pase viejo. */
const MAX_MERGE_HOPS = 5;

/** Fallos de PIN más viejos que esto ya no cuentan para el bloqueo. */
const PIN_FAILS_EXPIRE_MS = 12 * 60 * 60 * 1000;

/**
 * Una devolución a la tarjeta que se empezó a apuntar hace menos de esto está
 * en curso (otro clic espera); más vieja, el proceso se cayó y se retoma.
 */
const PAYOUT_CLAIM_MS = 2 * 60 * 1000;

type RawTx = Pick<Prisma.TransactionClient, '$queryRaw'>;

/** La wallet bloqueada (FOR UPDATE), con lo que hace falta para devolver o reabrir. */
async function lockWallet(
  tx: RawTx,
  walletId: string,
): Promise<{ id: string; balanceCents: number; status: string; shortCode: string | null } | null> {
  const rows = await tx.$queryRaw<Array<{ id: string; balanceCents: number; status: string; shortCode: string | null }>>`
    SELECT id, "balanceCents", status::text AS status, "shortCode" FROM client_wallets WHERE id = ${walletId}::uuid FOR UPDATE
  `;
  return rows[0] ?? null;
}

/**
 * Lo ya apuntado en el banco por la devolución a la tarjeta de este saldo que
 * empezó en `since`: las devoluciones hechas de sus recargas (y de las de los
 * saldos sumados a él) desde entonces. Solo la devolución del saldo toca esas
 * recargas (el resto de vías rechaza los cobros de recargas) y solo hay una a
 * medias por saldo: todo lo de después es suyo.
 */
async function registeredSince(tx: RawTx, walletId: string, since: Date): Promise<number> {
  const walletIds = await mergedWalletIds(tx, walletId);
  const rows = await tx.$queryRaw<Array<{ total: bigint }>>`
    SELECT COALESCE(SUM(r."amountCents"), 0)::bigint AS total
      FROM refunds r JOIN payments p ON p.id = r."paymentId"
     WHERE p."walletId" = ANY(${walletIds}::uuid[]) AND r.status = 'SUCCEEDED' AND r."createdAt" >= ${since}
  `;
  return Number(rows[0]?.total ?? 0);
}

/** Encargado o dueño del local. */
/**
 * La cifra que vio el panel (expectedAmountCents) tiene que ser la que se va a
 * apuntar: si el saldo se movió entre medias, 409 y no se toca nada. Sin ella
 * (paneles de antes), como siempre.
 */
function assertExpectedPayout(expectedCents: number | undefined, amountCents: number): void {
  if (expectedCents === undefined || expectedCents === amountCents) return;
  throw new ConflictException({
    message: `Lo que se devuelve ahora es ${eur(amountCents)}, no ${eur(expectedCents)} (el saldo ha cambiado): mira la cifra nueva y confirma otra vez`,
    code: 'PAYOUT_AMOUNT_CHANGED',
  });
}

function isManager(actor: { role: Role }): boolean {
  return actor.role === 'MANAGER' || actor.role === 'OWNER';
}

/** La clave del servidor con la que se mezcla el PIN (no está en la base). */
function pinPepper(): string {
  const kek = process.env.ENCRYPTION_KEK;
  if (!kek || kek.length < 32) throw new Error('ENCRYPTION_KEK no configurada: no se puede comprobar el PIN');
  return kek;
}

function eur(cents: number): string {
  return `${(cents / 100).toFixed(2).replace('.', ',')} €`;
}

/** "K7Q-•••": que el cliente reconozca su saldo sin enseñarlo entero. */
export function codeHintOf(shortCode: string | null): string {
  return `${(shortCode ?? '').slice(0, 3)}-•••`;
}

/** Lo que pide quien cobra del saldo: líneas, o (apps antiguas) un servicio o un importe con su sección. */
export interface QrChargeInput {
  lines?: ChargeLineInput[];
  serviceItemId?: string;
  amountCents?: number;
  category?: string;
  /** «Copa con invitación»: el QR personal de la chica invitada. */
  invitedStaffToken?: string;
  /** La propina que pidió el cliente (aparte del importe). */
  tipCents?: number;
  /** «Copa con invitación» con la chica elegida de la lista (si el local no pide su QR). */
  invitedOperatorId?: string;
}
