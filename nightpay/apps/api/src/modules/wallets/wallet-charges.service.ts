import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { isWalletCardToken, normalizeWalletCardUid, type Role } from '@nightpay/contracts';
import type { Prisma } from '@nightpay/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { resolveBpsForOperator, resolveRevenueCategory, type RevenueCategory } from '../payments/commission';
import { applyServiceItem } from '../payments/service-item';
import { hashPin, PIN_MAX_FAILS, PIN_PROBLEM_TEXT, pinProblem, verifyPin } from './wallet-pin';
import { reopenData } from './wallet-activation';
import { mergedWalletIds } from './wallet-merge-chain';
import { clientRefundState, refundCards, type ClientRefundState } from './wallet-refund-view';
import { attachCard, createCardToken, returnWalletCards, type CardBy } from './wallet-card-ops';
import { firstTopUp, isFreshTopUpBy, type TopUpBy } from './wallet-fresh-topup';
import { topUpTarget } from './wallet-topup-target';
import { assertVenueAcceptsCharges } from '../venues/venue-pause';
import { assertVenueAcceptsMethods } from '../venues/venue-methods';
import { TotpService } from '../auth/totp.service';
import { assertManagerTwoFactor } from './wallet-two-factor';
// Solo el TIPO: el valor se resuelve con ModuleRef (ciclo Wallets→Refunds→Payments→Wallets).
import type { RefundsService } from '../refunds/refunds.service';
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
export type WalletRef = { code: string } | { card: string; uid?: string | null };

/** Datáfono vinculado (Authorization: Device): no hay persona, solo su local. */
export interface TerminalActor {
  terminalId: string;
  tenantId: string;
}

/** En el datáfono, además: el QR de su pase de Google Wallet (/w/<token>). */
export type TerminalWalletRef = WalletRef | { walletToken: string };

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
  status: ChargeRequestStatus;
  amountCents: number;
  serviceName: string | null;
  expiresAt: string;
  newBalanceCents: number | null;
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
    venueName: string | null;
    at: string;
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

const MERGE_BLOCKED = 'Uno de los dos saldos está bloqueado: no se pueden juntar. Pregunta en el local.';

/**
 * Saldo NightPay. La chica hace el cobro con un QR: el cliente lo paga desde
 * su móvil con Face ID o, sin sacar el móvil, con su código o su ficha NFC y
 * su PIN; sin batería, lo aprueba otro encargado. Al irse, el encargado le
 * devuelve el saldo a la tarjeta (hecho en BBVA) o en efectivo.
 */
@Injectable()
export class WalletChargesService {
  private readonly logger = new Logger(WalletChargesService.name);
  private readonly prisma: PrismaService;
  private readonly audit: AuditService;
  private readonly moduleRef: ModuleRef;
  private readonly totp: TotpService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(AuditService) audit: AuditService,
    @Inject(ModuleRef) moduleRef: ModuleRef,
    @Inject(TotpService) totp: TotpService,
  ) {
    this.prisma = prisma;
    this.audit = audit;
    this.moduleRef = moduleRef;
    this.totp = totp;
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
      this.prisma.acrossVenues((tx) => tx.walletCard.count({ where: { walletId: wallet.id, status: 'ISSUED' } })),
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

  /** Importe, categoría y nombre del cobro: de la carta o tecleado (con el tope de la chica). */
  private async resolveCharge(
    actor: Actor,
    input: { serviceItemId?: string; amountCents?: number; category?: string },
  ): Promise<{ amountCents: number; category: RevenueCategory; serviceName: string | null }> {
    let amountCents: number;
    let category: RevenueCategory;
    let serviceName: string | null = null;
    if (input.serviceItemId) {
      const item = await this.prisma.serviceItem.findFirst({
        where: { id: input.serviceItemId, tenantId: actor.tenantId },
      });
      if (!item) throw new NotFoundException('Ese servicio no está en la carta de este local');
      const charge = applyServiceItem(item, actor.role);
      if (!charge.ok) throw new BadRequestException('Ese servicio no se puede cobrar desde tu app');
      amountCents = charge.amountCents;
      category = charge.revenueCategory;
      serviceName = charge.serviceName;
    } else {
      if (!input.amountCents || input.amountCents <= 0) throw new BadRequestException('Pon el importe');
      const resolved = resolveRevenueCategory({
        isWalletTopUp: false,
        creatorRole: actor.role,
        requested: (input.category as RevenueCategory | undefined) ?? null,
      });
      if (!resolved) throw new BadRequestException('Desde tu app solo puedes cobrar tus servicios');
      amountCents = input.amountCents;
      category = resolved;
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
    return { amountCents, category, serviceName };
  }

  /** La chica espera a que el cliente pague (solo la que lo hizo, o el encargado). */
  async getRequest(actor: Actor, requestId: string): Promise<ChargeRequestView> {
    const request = await this.ownRequest(actor, requestId);
    const walletId = request.walletId;
    const wallet = walletId
      ? await this.prisma.acrossVenues((tx) =>
          tx.clientWallet.findUnique({ where: { id: walletId }, select: { balanceCents: true } }),
        )
      : null;
    return this.requestView(request, request.status === 'ACCEPTED' ? (wallet?.balanceCents ?? null) : null);
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

  async clientState(qrToken: string): Promise<ClientWalletState> {
    const wallet = await this.walletByToken(qrToken);
    const [consumptions, topUps, allPayouts, cashTopUps] = await Promise.all([
      this.prisma.asSystem((tx) =>
        tx.walletConsumption.findMany({
          where: { walletId: wallet.id, reversedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 30,
          select: { amountCents: true, tipCents: true, category: true, notes: true, tenantId: true, createdAt: true },
        }),
      ),
      this.prisma.asSystem((tx) =>
        tx.payment.findMany({
          where: { walletId: wallet.id, status: { in: ['AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED'] } },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: { amountCents: true, tenantId: true, authorizedAt: true, createdAt: true, cardLast4: true },
        }),
      ),
      this.prisma.asSystem((tx) =>
        tx.walletPayout.findMany({
          // Hechas y la que se está apuntando a la tarjeta (paso «Aprobado» del «Me voy»).
          where: { walletId: wallet.id, status: { in: ['DONE', 'PENDING'] } },
          orderBy: { createdAt: 'desc' },
          select: { amountCents: true, method: true, status: true, tenantId: true, createdAt: true },
        }),
      ),
      // En efectivo en la recepción (no pasan por el banco).
      this.prisma.asSystem((tx) =>
        tx.walletCashTopUp.findMany({
          where: { walletId: wallet.id },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: { amountCents: true, tenantId: true, createdAt: true },
        }),
      ),
    ]);
    // En movimientos, solo las hechas (una a la tarjeta a medias aún no es una devolución).
    const payouts = allPayouts.filter((p) => p.status === 'DONE');
    const hasFaceId = (await this.prisma.walletPasskey.count({ where: { walletId: wallet.id } })) > 0;
    const venueIds = [...new Set([...consumptions, ...topUps, ...cashTopUps, ...payouts].map((m) => m.tenantId))];
    const venues = await this.prisma.venue.findMany({ where: { id: { in: venueIds } }, select: { id: true, name: true } });
    const venueName = (id: string): string => venues.find((v) => v.id === id)?.name ?? '';

    const movements: ClientWalletState['movements'] = [
      ...consumptions.map((c) => ({
        kind: 'consumption' as const,
        amountCents: -(c.amountCents + c.tipCents),
        label: c.notes?.split('\n')[0]?.trim() || categoryLabel(c.category),
        venueName: venueName(c.tenantId),
        at: c.createdAt.toISOString(),
      })),
      ...topUps.map((t) => ({
        kind: 'topup' as const,
        amountCents: t.amountCents,
        label: 'Recarga',
        venueName: venueName(t.tenantId),
        at: (t.authorizedAt ?? t.createdAt).toISOString(),
      })),
      ...cashTopUps.map((t) => ({
        kind: 'topup' as const,
        amountCents: t.amountCents,
        label: 'Recarga en efectivo',
        venueName: venueName(t.tenantId),
        at: t.createdAt.toISOString(),
      })),
      ...payouts.map((p) => ({
        kind: 'payout' as const,
        amountCents: -p.amountCents,
        label: p.method === 'CASH' ? 'Devuelto en efectivo' : 'Devuelto a la tarjeta',
        venueName: venueName(p.tenantId),
        at: p.createdAt.toISOString(),
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
  private async settleRequest(walletId: string, requestId: string): Promise<void> {
    const wallet = { id: walletId };
    await this.prisma.acrossVenues(async (tx) => {
      // blockedAt: saldo bloqueado por el super-admin → no paga (decideAccept).
      const locked = await tx.$queryRaw<
        Array<{ id: string; balanceCents: number; status: string; blockedAt: Date | null }>
      >`
        SELECT id, "balanceCents", status::text AS status, "blockedAt"
          FROM client_wallets WHERE id = ${wallet.id}::uuid FOR UPDATE
      `;
      const w = locked[0];
      if (!w) throw new NotFoundException('Saldo no encontrado');
      const bound = await tx.walletChargeRequest.updateMany({
        where: { id: requestId, walletId: null, status: 'PENDING' },
        data: { walletId: wallet.id },
      });
      if (bound.count === 0) throw new ConflictException(REQUEST_ERRORS['not-pending']);
      const request = await tx.walletChargeRequest.findFirst({ where: { id: requestId, walletId: wallet.id } });
      if (!request) throw new NotFoundException('Cobro no encontrado');
      const decision = decideAccept(request, w, new Date());
      if (!decision.ok) throw new ConflictException(REQUEST_ERRORS[decision.reason]);

      const [provider, venue] = await Promise.all([
        tx.user.findUnique({ where: { id: request.requestedByUserId }, select: { role: true, commissionBps: true } }),
        tx.venue.findUnique({ where: { id: request.tenantId }, select: { operatorCommissionDefaults: true } }),
      ]);
      const consumption = await tx.walletConsumption.create({
        data: {
          tenantId: request.tenantId,
          walletId: wallet.id,
          amountCents: request.amountCents,
          providedByUserId: request.requestedByUserId,
          category: request.category,
          notes: request.serviceName,
          idempotencyKey: `charge-request:${request.id}`,
        },
      });
      if (provider?.role === 'OPERATOR') {
        const bps = resolveBpsForOperator({
          category: request.category,
          userCommissionBpsOverride: provider.commissionBps,
          venueMap: (venue?.operatorCommissionDefaults ?? null) as Record<string, number> | null,
        });
        if (bps > 0) {
          await tx.operatorEarning.create({
            data: {
              tenantId: request.tenantId,
              operatorId: request.requestedByUserId,
              consumptionId: consumption.id,
              paymentAmountCents: request.amountCents,
              commissionBps: bps,
              commissionCents: Math.round((request.amountCents * bps) / 10_000),
            },
          });
        }
      }
      const newBalance = w.balanceCents - request.amountCents;
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
      if (accepted.count === 0) throw new ConflictException(REQUEST_ERRORS['not-pending']);
    });
  }

  // ─── Cobro con QR y Face ID (el cliente paga desde su móvil) ─────────────

  /**
   * La chica elige el servicio y enseña un QR. Aún no se sabe de quién es el
   * saldo: lo dice la llave (Face ID) con la que el cliente paga.
   */
  async createQrCharge(
    actor: Actor,
    input: { serviceItemId?: string; amountCents?: number; category?: string },
  ): Promise<QrChargeView> {
    // Local (o su negocio) en pausa: sin cobros del saldo nuevos (423 VENUE_PAUSED).
    // Pago con saldo apagado en Ajustes: 409 PAYMENT_METHOD_DISABLED.
    await this.prisma.asSystem(async (tx) => {
      await assertVenueAcceptsCharges(tx, actor.tenantId);
      await assertVenueAcceptsMethods(tx, actor.tenantId, ['wallet']);
    });
    const { amountCents, category, serviceName } = await this.resolveCharge(actor, input);
    const payToken = randomBytes(24).toString('base64url');
    const request = await this.prisma.asSystem((tx) =>
      tx.walletChargeRequest.create({
        data: {
          tenantId: actor.tenantId,
          walletId: null,
          requestedByUserId: actor.userId,
          amountCents,
          category,
          serviceName,
          payToken,
          expiresAt: new Date(Date.now() + QR_CHARGE_TTL_MS),
        },
      }),
    );
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
    return {
      status,
      amountCents: request.amountCents,
      serviceName: request.serviceName,
      venueName: venue?.name ?? '',
      requestedByName: requester?.displayName ?? null,
      expiresAt: request.expiresAt.toISOString(),
      paidAt: status === 'ACCEPTED' && request.decidedAt ? request.decidedAt.toISOString() : null,
    };
  }

  /**
   * El cliente pagó con su llave: `walletId` es el saldo de esa llave (ya
   * comprobada). Se ata el cobro a ese saldo y se cobra; si no se puede (no
   * llega, otro grupo…), el cobro vuelve a quedar libre para otro saldo.
   */
  async payQrCharge(payToken: string, walletId: string): Promise<{ amountCents: number; balanceCents: number }> {
    const request = await this.qrRequest(payToken);
    await this.bindAndSettle(request, walletId);
    const wallet = await this.prisma.acrossVenues((tx) =>
      tx.clientWallet.findUnique({ where: { id: walletId }, select: { balanceCents: true } }),
    );
    this.logger.log(`Saldo ${walletId}: cobro ${request.id} pagado con su llave (QR)`);
    return { amountCents: request.amountCents, balanceCents: wallet?.balanceCents ?? 0 };
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
    rows: Array<{ id: string; amountCents: number; serviceName: string | null; requestedByUserId: string; createdAt: Date; expiresAt: Date }>,
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
        amountCents: r.amountCents,
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
   * (la parte de la chica queda como siempre). Queda en la auditoría.
   */
  async approveWithoutFaceId(actor: Actor, requestId: string, walletId: string): Promise<ChargeRequestView> {
    await this.managerWallet(actor, walletId);
    const request = await this.prisma.asSystem((tx) =>
      tx.walletChargeRequest.findFirst({ where: { id: requestId, tenantId: actor.tenantId, payToken: { not: null } } }),
    );
    if (!request) throw new NotFoundException('Cobro no encontrado');
    // Sin el cliente, hacen falta dos personas: la que cobra y otra que aprueba.
    if (request.requestedByUserId === actor.userId) {
      throw new ForbiddenException('Este cobro lo has hecho tú: lo tiene que aprobar otro encargado o el dueño');
    }
    await this.bindAndSettle(request, walletId);
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
   * Recarga nueva sumada al saldo que el cliente ya tenía (lo dice su llave).
   * El saldo nuevo queda a 0 y apuntando al otro (sus pagos siguen siendo
   * suyos, para devolverlos a la tarjeta).
   */
  async mergeInto(sourceWalletId: string, targetWalletId: string): Promise<{ balanceCents: number }> {
    if (sourceWalletId === targetWalletId) throw new ConflictException('Es el mismo saldo');
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
      if (open.length > 0) throw new ConflictException('Esta recarga tiene otro pago a medias: inténtalo en unos minutos');
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
      if (source.blockedAt || target.blockedAt) throw new ConflictException(MERGE_BLOCKED);
      if (!sameWalletGroup(target, { id: source.tenantId, walletGroup: source.walletGroup })) {
        throw new ConflictException('Ese saldo es de otro local: no se pueden juntar');
      }
      if (source.status !== 'ACTIVE' || source.balanceCents <= 0 || source.mergedIntoId) {
        throw new ConflictException('Esta recarga ya no se puede sumar');
      }
      // Un saldo ya sumado a otro no recibe dinero: el del cliente es aquel.
      if ((target.status !== 'ACTIVE' && target.status !== 'DEPLETED') || target.mergedIntoId) {
        throw new ConflictException('Tu saldo está cerrado');
      }
      const keys = await tx.walletPasskey.count({ where: { walletId: sourceWalletId } });
      if (keys > 0) throw new ConflictException('Esta recarga ya tiene su propio Face ID');
      // A 0 (DEPLETED) se reabre; si su código lo tiene ya otro cliente, con uno nuevo.
      await tx.clientWallet.update({
        where: { id: targetWalletId },
        data: { balanceCents: { increment: source.balanceCents }, ...(await reopenData(tx, target)) },
      });
      await tx.clientWallet.update({
        where: { id: sourceWalletId },
        data: { balanceCents: 0, status: 'DEPLETED', mergedIntoId: targetWalletId },
      });
      return { moved: source.balanceCents, tenantId: source.tenantId, balanceCents: target.balanceCents + source.balanceCents };
    });
    await this.audit.log({
      action: 'wallet.merged',
      tenantId: result.tenantId,
      targetType: 'ClientWallet',
      targetId: targetWalletId,
      payload: { from: sourceWalletId, amountCents: result.moved },
    });
    return { balanceCents: result.balanceCents };
  }

  // ─── PIN del cliente (pagar sin sacar el móvil) ─────────────────────────

  /**
   * El cliente no saca el móvil: la chica pone su código y él teclea su PIN
   * en el móvil de ella. Se paga el mismo cobro del QR (no queda otro colgado).
   */
  async payQrChargeWithPin(actor: Actor, requestId: string, input: WalletRef & { pin: string }): Promise<ChargeRequestView> {
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
      throw new ConflictException(REQUEST_ERRORS['not-pending']);
    }
    const wallet = await this.walletByRef(actor.tenantId, input);
    // Un PIN que puso el encargado sin el cliente: ni él cobra con ese PIN ni
    // aprueba un cobro suyo (hacen falta dos personas, como sin Face ID).
    if (wallet.pinSetById && (wallet.pinSetById === actor.userId || wallet.pinSetById === request.requestedByUserId)) {
      throw new ForbiddenException('Este PIN lo pusiste tú: el cobro lo tiene que hacer otra persona');
    }
    await this.checkPin(wallet.id, input.pin, actor);
    await this.bindAndSettle(request, wallet.id);
    if ('card' in input) await this.touchCard(wallet.id, input);
    this.logger.log(`Saldo ${wallet.id}: cobro ${request.id} pagado con PIN (${'card' in input ? 'ficha' : 'código'}, ${actor.userId})`);
    return this.getRequest(actor, requestId);
  }

  /** Ficha usada para pagar: cuándo, y su número de serie si aún no lo tenía. */
  private async touchCard(walletId: string, input: { card: string; uid?: string | null }): Promise<void> {
    const uid = input.uid ? normalizeWalletCardUid(input.uid) : null;
    await this.prisma.acrossVenues(async (tx) => {
      await tx.walletCard.updateMany({ where: { token: input.card, walletId }, data: { lastUsedAt: new Date() } });
      // Ficha dada desde un iPhone: su número de serie, la primera vez que la lee un Android.
      if (uid) await tx.walletCard.updateMany({ where: { token: input.card, uid: null }, data: { uid } });
    });
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
    this.assertPayable(request);
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
    if (wallet.blockedAt) throw new ConflictException(REQUEST_ERRORS.blocked);
    return {
      codeHint: codeHintOf(wallet.shortCode),
      hasPin: wallet.pinHash !== null,
      pinLocked: wallet.pinLockedAt !== null,
      pinByStaff: wallet.pinSetById !== null,
      enough: wallet.balanceCents >= request.amountCents,
    };
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
    await this.bindAndSettle(request, wallet.id);
    if ('card' in input) await this.touchCard(wallet.id, input);
    const via = 'card' in input ? 'ficha' : 'walletToken' in input ? 'pase' : 'código';
    await this.audit.log({
      action: 'wallet.pin_charge_terminal',
      tenantId: terminal.tenantId,
      targetType: 'ClientWallet',
      targetId: wallet.id,
      payload: { requestId, amountCents: request.amountCents, terminalId: terminal.terminalId, via },
    });
    this.logger.log(`Saldo ${wallet.id}: cobro ${request.id} pagado con PIN en el datáfono ${terminal.terminalId} (${via})`);
    const [fresh, after] = await Promise.all([
      this.prisma.asSystem((tx) => tx.walletChargeRequest.findFirst({ where: { id: request.id } })),
      this.prisma.acrossVenues((tx) =>
        tx.clientWallet.findUnique({ where: { id: wallet.id }, select: { balanceCents: true } }),
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
    this.assertPayable(request);
    return request;
  }

  private assertPayable(request: { status: string; expiresAt: Date; walletId: string | null }): void {
    const status = effectiveRequestStatus(request, new Date());
    if (status === 'EXPIRED') throw new ConflictException(REQUEST_ERRORS.expired);
    if (status !== 'PENDING' || request.walletId) throw new ConflictException(REQUEST_ERRORS['not-pending']);
  }

  private async walletByTerminalRef(venueId: string, ref: TerminalWalletRef) {
    return 'walletToken' in ref ? this.walletByLinkToken(venueId, ref.walletToken) : this.walletByRef(venueId, ref);
  }

  /**
   * El QR del pase de Google Wallet (el enlace /w/<token> del saldo): su saldo
   * si sigue abierto y vale en este local. Una recarga sumada a otro saldo
   * lleva a ese otro (el pase viejo sigue valiendo).
   */
  private async walletByLinkToken(venueId: string, token: string) {
    const [first, venue] = await Promise.all([
      this.prisma.acrossVenues((tx) => tx.clientWallet.findUnique({ where: { qrToken: token } })),
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
    await this.assertMethods(venueId, ['nfc']);
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
    const cards = await this.prisma.acrossVenues((tx) => tx.walletCard.count({ where: { walletId, status: 'ISSUED' } }));
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
    const res = await this.prisma.acrossVenues((tx) =>
      tx.walletCard.updateMany({
        where: { walletId, status: 'ISSUED' },
        data: { status: 'BLOCKED', blockedAt: new Date() },
      }),
    );
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
  private async walletByCard(venueId: string, input: { card: string; uid?: string | null }) {
    const card = isWalletCardToken(input.card)
      ? await this.prisma.acrossVenues((tx) => tx.walletCard.findUnique({ where: { token: input.card } }))
      : null;
    if (!card || card.status !== 'ISSUED' || !card.walletId) {
      throw new NotFoundException('Esta ficha no tiene saldo: dásela al cliente al recargar');
    }
    const uid = input.uid ? normalizeWalletCardUid(input.uid) : null;
    // Sin uid (la lee un iPhone) no se puede comprobar que sea la original:
    // vale solo para saber de qué saldo es; pagar sigue pidiendo su PIN.
    if (card.uid && uid && card.uid !== uid) {
      this.logger.warn(`Ficha ${card.id}: número de serie distinto (¿copia?)`);
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
    return wallet;
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

  /** Encargado o dueño: el cliente olvidó su PIN → se borra y elige otro. */
  async resetPin(actor: Actor, walletId: string): Promise<{ ok: true }> {
    await this.managerWallet(actor, walletId);
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
        if (w.pinFails > 0) {
          await tx.clientWallet.update({ where: { id: walletId }, data: { pinFails: 0, pinFailedAt: null } });
        }
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
        throw new UnprocessableEntityException('Saldo bloqueado por PIN fallado: avisa al encargado para desbloquearlo');
      case 'now-locked':
        this.logger.warn(`Saldo ${walletId}: bloqueado tras ${PIN_MAX_FAILS} PIN fallidos`);
        throw new UnprocessableEntityException('PIN incorrecto. Saldo bloqueado: avisa al encargado para desbloquearlo');
      case 'wrong':
        throw new UnprocessableEntityException(
          `PIN incorrecto. ${outcome.left === 1 ? 'Queda 1 intento' : `Quedan ${outcome.left} intentos`}`,
        );
    }
  }

  /**
   * Guarda el primer PIN (si ya hay uno, solo el encargado lo puede borrar).
   * `setById`: el encargado que lo pone sin el cliente delante (null si lo
   * eligió el cliente: en su móvil o con la chica justo tras recargar).
   */
  private async storeFirstPin(walletId: string, pin: string, setById: string | null): Promise<void> {
    const problem = pinProblem(pin);
    if (problem) throw new BadRequestException(PIN_PROBLEM_TEXT[problem]);
    const pinHash = await hashPin(pin, pinPepper());
    const res = await this.prisma.acrossVenues((tx) =>
      tx.clientWallet.updateMany({
        where: { id: walletId, pinHash: null },
        data: { pinHash, pinFails: 0, pinFailedAt: null, pinLockedAt: null, pinSetById: setById },
      }),
    );
    if (res.count === 0) throw new ConflictException('Este saldo ya tiene PIN');
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

  /** Ata un cobro con QR a un saldo y lo cobra (todo o nada: si falla, el cobro sigue libre). */
  private async bindAndSettle(
    request: { id: string; tenantId: string; status: string; expiresAt: Date; walletId: string | null },
    walletId: string,
  ): Promise<void> {
    if (effectiveRequestStatus(request, new Date()) !== 'PENDING' || request.walletId) {
      throw new ConflictException(REQUEST_ERRORS['not-pending']);
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
      throw new ConflictException('Tu saldo no vale en este local');
    }
    await this.settleRequest(walletId, request.id);
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
    if (wallet.balanceCents <= 0) throw new ConflictException('No te queda saldo que devolver');
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
   * Devuelve todo el saldo y cierra la wallet.
   *  - CASH: en efectivo en el local (dueño o encargado), en una transacción.
   *    El encargado, desde el umbral del local, con su código 2FA.
   *  - CARD: ya hecho en el portal de BBVA (solo el dueño): se reparte entre
   *    las recargas y se apunta como devolución de cada una (payoutCard).
   */
  async payout(
    actor: Actor,
    walletId: string,
    input: { method: WalletPayoutMethod; bankReference?: string; note?: string; totpCode?: string },
  ): Promise<{ refundedCents: number; method: WalletPayoutMethod }> {
    if (input.method === 'CARD' && actor.role !== 'OWNER') {
      throw new ForbiddenException('La devolución a la tarjeta la registra el dueño (se hace en el portal de BBVA)');
    }
    if (input.method === 'CASH' && !isManager(actor)) {
      throw new ForbiddenException('Devolver en efectivo lo hace el encargado');
    }
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
    return input.method === 'CASH'
      ? this.payoutCash(actor, walletId, input, venue?.refundApprovalThresholdCents)
      : this.payoutCard(actor, walletId, input);
  }

  /**
   * En efectivo: en una sola transacción se cierra el saldo y se apunta la
   * devolución. El 2FA del encargado se mira con el saldo ya bloqueado (lo
   * que se devuelve es lo que hay ahora, no lo que vio el panel).
   */
  private async payoutCash(
    actor: Actor,
    walletId: string,
    input: { bankReference?: string; note?: string; totpCode?: string },
    thresholdCents: number | undefined,
  ): Promise<{ refundedCents: number; method: WalletPayoutMethod }> {
    const { amount, twoFactor } = await this.prisma.acrossVenues(async (tx) => {
      const w = await lockWallet(tx, walletId);
      if (!w || w.status !== 'ACTIVE' || w.balanceCents <= 0) {
        const halfDone = await tx.walletPayout.findFirst({ where: { walletId, status: 'PENDING' } });
        throw new ConflictException(
          halfDone
            ? `Hay una devolución a la tarjeta de ${eur(halfDone.amountCents)} a medias: que el dueño vuelva a pulsar «A la tarjeta» para terminarla`
            : 'Este saldo no tiene nada que devolver',
        );
      }
      const asked = await assertManagerTwoFactor(
        this.totp,
        actor,
        w.balanceCents,
        thresholdCents,
        input.totpCode,
        `Devolver ${eur(w.balanceCents)} en efectivo`,
      );
      await tx.clientWallet.update({ where: { id: walletId }, data: { balanceCents: 0, status: 'REFUNDED' } });
      // «Me voy»: el cliente devuelve la ficha y vuelve al stock (si no, el encargado la marca perdida).
      await returnWalletCards(tx, walletId, actor.tenantId);
      await tx.walletPayout.create({
        data: {
          tenantId: actor.tenantId,
          walletId,
          amountCents: w.balanceCents,
          method: 'CASH',
          status: 'DONE',
          bankReference: input.bankReference ?? null,
          note: input.note ?? null,
          paidByUserId: actor.userId,
        },
      });
      return { amount: w.balanceCents, twoFactor: asked };
    });
    await this.audit.log({
      action: 'wallet.payout',
      tenantId: actor.tenantId,
      actorId: actor.userId,
      targetType: 'ClientWallet',
      targetId: walletId,
      payload: { method: 'CASH', refundedCents: amount, remainingCents: 0, twoFactor },
    });
    return { refundedCents: amount, method: 'CASH' };
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
    input: { bankReference?: string; note?: string },
  ): Promise<{ refundedCents: number; method: WalletPayoutMethod }> {
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
    input: { bankReference?: string; note?: string },
  ): Promise<{ id: string; amountCents: number; createdAt: Date; bankReference: string | null; resumed: boolean }> {
    return this.prisma.acrossVenues(async (tx) => {
      const w = await lockWallet(tx, walletId);
      if (!w) throw new NotFoundException('Saldo no encontrado');
      const open = await tx.walletPayout.findFirst({ where: { walletId, status: 'PENDING' } });
      if (open) {
        if (open.claimedAt && Date.now() - open.claimedAt.getTime() < PAYOUT_CLAIM_MS) {
          throw new ConflictException('Ya se está apuntando la devolución de este saldo: espera un momento');
        }
        // Se quedó a medias (el proceso se cayó): se retoma con lo que ya se apuntó.
        await tx.walletPayout.update({ where: { id: open.id }, data: { claimedAt: new Date() } });
        this.logger.warn(`Saldo ${walletId}: se retoma la devolución a la tarjeta ${open.id} que quedó a medias`);
        return { id: open.id, amountCents: open.amountCents, createdAt: open.createdAt, bankReference: open.bankReference, resumed: true };
      }
      if (w.status !== 'ACTIVE' || w.balanceCents <= 0) throw new ConflictException('Este saldo no tiene nada que devolver');
      await tx.clientWallet.update({ where: { id: walletId }, data: { balanceCents: 0 } });
      const created = await tx.walletPayout.create({
        data: {
          tenantId: actor.tenantId,
          walletId,
          amountCents: w.balanceCents,
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
      if (balance === 0) await returnWalletCards(tx, walletId, row.tenantId);
      return { refunded, remaining };
    });
  }

  /**
   * El cliente perdió el enlace de su saldo (pagó en otro navegador, borró la
   * página…). El dueño le da uno nuevo y el viejo deja de valer: quien lo
   * hubiera visto ya no puede aceptar cobros con él.
   */
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
    const removedKeys = await this.prisma.acrossVenues(async (tx) => {
      await tx.clientWallet.update({ where: { id: walletId }, data: { qrToken } });
      return (await tx.walletPasskey.deleteMany({ where: { walletId } })).count;
    });
    await this.audit.log({
      action: 'wallet.relinked',
      tenantId: actor.tenantId,
      actorId: actor.userId,
      targetType: 'ClientWallet',
      targetId: walletId,
      payload: { balanceCents: wallet.balanceCents, removedPasskeys: removedKeys },
    });
    return { path: `/w/${qrToken}` };
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
    return this.moduleRef.get<RefundsService>('RefundsService', { strict: false });
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
    if (!wallet) throw new NotFoundException('Saldo no encontrado');
    return wallet;
  }

  private requestView(
    r: { id: string; status: string; amountCents: number; serviceName: string | null; expiresAt: Date },
    newBalanceCents: number | null,
  ): ChargeRequestView {
    return {
      id: r.id,
      status: effectiveRequestStatus(r, new Date()),
      amountCents: r.amountCents,
      serviceName: r.serviceName,
      expiresAt: r.expiresAt.toISOString(),
      newBalanceCents,
    };
  }
}

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

function categoryLabel(category: string): string {
  const map: Record<string, string> = {
    CHICA_SERVICE: 'Servicio',
    VENUE_BAR: 'Barra',
    VENUE_ROOM: 'Habitación',
    VENUE_FOOD: 'Comida',
    EXTRA: 'Otro',
  };
  return map[category] ?? 'Consumo';
}
