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
import type { Role } from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { resolveBpsForOperator, resolveRevenueCategory, type RevenueCategory } from '../payments/commission';
import { applyServiceItem } from '../payments/service-item';
import { hashPin, PIN_MAX_FAILS, PIN_PROBLEM_TEXT, pinProblem, verifyPin } from './wallet-pin';
// Solo el TIPO: el valor se resuelve con ModuleRef (ciclo Wallets→Refunds→Payments→Wallets).
import type { RefundsService } from '../refunds/refunds.service';
import {
  CHARGE_REQUEST_TTL_MS,
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
  pendingRequest: boolean;
  /** Puede pagar sin sacar el móvil, con su PIN. */
  hasPin: boolean;
  /** 5 PIN fallidos: hasta que lo desbloquee el encargado. */
  pinLocked: boolean;
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
  pending: {
    id: string;
    amountCents: number;
    serviceName: string | null;
    requestedByName: string;
    venueName: string;
    expiresAt: string;
  } | null;
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

const REQUEST_ERRORS: Record<'not-pending' | 'expired' | 'wallet-closed' | 'insufficient', string> = {
  'not-pending': 'Este cobro ya no está pendiente',
  expired: 'Este cobro ha caducado: pide a la chica que lo repita',
  'wallet-closed': 'Este saldo ya está cerrado',
  insufficient: 'No hay saldo suficiente para este cobro',
};

/**
 * Saldo NightPay. La chica encuentra el saldo por el código que enseña el
 * cliente y le pide un cobro; el cliente lo acepta en su móvil. Al irse, el
 * encargado le devuelve el saldo a la tarjeta (hecho en BBVA) o en efectivo.
 */
@Injectable()
export class WalletChargesService {
  private readonly logger = new Logger(WalletChargesService.name);
  private readonly prisma: PrismaService;
  private readonly audit: AuditService;
  private readonly moduleRef: ModuleRef;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(AuditService) audit: AuditService,
    @Inject(ModuleRef) moduleRef: ModuleRef,
  ) {
    this.prisma = prisma;
    this.audit = audit;
    this.moduleRef = moduleRef;
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
    const manager = actor.role === 'MANAGER' || actor.role === 'OWNER';
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
    const [home, pending] = await Promise.all([
      this.prisma.venue.findUnique({ where: { id: wallet.tenantId }, select: { name: true } }),
      this.pendingOf(wallet.id),
    ]);
    return {
      walletId: wallet.id,
      code: formatWalletCode(wallet.shortCode ?? ''),
      balanceCents: wallet.balanceCents,
      label: wallet.identifier,
      homeVenueName: home?.name ?? '',
      isHomeVenue: wallet.tenantId === venueId,
      closeRequested: wallet.closeRequestedAt !== null,
      pendingRequest: pending !== null,
      hasPin: wallet.pinHash !== null,
      pinLocked: wallet.pinLockedAt !== null,
    };
  }

  /**
   * Pide un cobro del saldo: con un servicio de la carta (precio y categoría
   * del local) o un importe. El cliente lo tiene que aceptar en su móvil.
   */
  async createRequest(
    actor: Actor,
    input: { code: string; serviceItemId?: string; amountCents?: number; category?: string },
  ): Promise<ChargeRequestView> {
    const wallet = await this.walletByCode(actor.tenantId, input.code);
    if (await this.hasFaceId(wallet.id)) {
      throw new ConflictException('Este cliente paga con Face ID: enséñale el QR del cobro');
    }
    const { amountCents, category, serviceName } = await this.resolveCharge(actor, input);
    const request = await this.prisma.acrossVenues(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ balanceCents: number; status: string }>>`
        SELECT "balanceCents", status::text AS status FROM client_wallets WHERE id = ${wallet.id}::uuid FOR UPDATE
      `;
      const w = locked[0];
      if (!w || w.status !== 'ACTIVE') throw new ConflictException('Este saldo ya está cerrado');
      if (amountCents > w.balanceCents) {
        throw new ConflictException(`Al cliente le quedan ${eur(w.balanceCents)}: no llega para ${eur(amountCents)}`);
      }
      const now = new Date();
      await tx.walletChargeRequest.updateMany({
        where: { walletId: wallet.id, status: 'PENDING', expiresAt: { lte: now } },
        data: { status: 'EXPIRED', decidedAt: now },
      });
      const pending = await tx.walletChargeRequest.findFirst({ where: { walletId: wallet.id, status: 'PENDING' } });
      if (pending) throw new ConflictException('El cliente tiene otro cobro esperando su confirmación');
      return tx.walletChargeRequest.create({
        data: {
          tenantId: actor.tenantId,
          walletId: wallet.id,
          requestedByUserId: actor.userId,
          amountCents,
          category,
          serviceName,
          expiresAt: new Date(now.getTime() + CHARGE_REQUEST_TTL_MS),
        },
      });
    });
    return this.requestView(request, null);
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

  /** La chica espera la respuesta del cliente. */
  async getRequest(actor: Actor, requestId: string): Promise<ChargeRequestView> {
    const request = await this.prisma.asSystem((tx) =>
      tx.walletChargeRequest.findFirst({ where: { id: requestId, tenantId: actor.tenantId } }),
    );
    if (!request) throw new NotFoundException('Cobro no encontrado');
    const walletId = request.walletId;
    const wallet = walletId
      ? await this.prisma.acrossVenues((tx) =>
          tx.clientWallet.findUnique({ where: { id: walletId }, select: { balanceCents: true } }),
        )
      : null;
    return this.requestView(request, request.status === 'ACCEPTED' ? (wallet?.balanceCents ?? null) : null);
  }

  async cancelRequest(actor: Actor, requestId: string): Promise<{ ok: true }> {
    const res = await this.prisma.asSystem((tx) =>
      tx.walletChargeRequest.updateMany({
        where: { id: requestId, tenantId: actor.tenantId, status: 'PENDING' },
        data: { status: 'CANCELED', decidedAt: new Date() },
      }),
    );
    if (res.count === 0) throw new ConflictException('Este cobro ya no está pendiente');
    return { ok: true };
  }

  // ─── Cliente (página de su saldo, sin cuenta: el enlace es la credencial) ──

  async clientState(qrToken: string): Promise<ClientWalletState> {
    const wallet = await this.walletByToken(qrToken);
    const [pending, consumptions, topUps, payouts] = await Promise.all([
      this.pendingOf(wallet.id),
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
          select: { amountCents: true, tenantId: true, authorizedAt: true, createdAt: true },
        }),
      ),
      this.prisma.asSystem((tx) =>
        tx.walletPayout.findMany({
          where: { walletId: wallet.id },
          orderBy: { createdAt: 'desc' },
          select: { amountCents: true, method: true, tenantId: true, createdAt: true },
        }),
      ),
    ]);
    const hasFaceId = (await this.prisma.walletPasskey.count({ where: { walletId: wallet.id } })) > 0;
    const venueIds = [
      ...new Set([...consumptions, ...topUps, ...payouts].map((m) => m.tenantId).concat(pending ? [pending.tenantId] : [])),
    ];
    const venues = await this.prisma.venue.findMany({ where: { id: { in: venueIds } }, select: { id: true, name: true } });
    const venueName = (id: string): string => venues.find((v) => v.id === id)?.name ?? '';
    const requester = pending
      ? await this.prisma.asSystem((tx) =>
          tx.user.findUnique({ where: { id: pending.requestedByUserId }, select: { displayName: true } }),
        )
      : null;

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
      ...payouts.map((p) => ({
        kind: 'payout' as const,
        amountCents: -p.amountCents,
        label: p.method === 'CASH' ? 'Devuelto en efectivo' : 'Devuelto a la tarjeta',
        venueName: venueName(p.tenantId),
        at: p.createdAt.toISOString(),
      })),
    ].sort((a, b) => b.at.localeCompare(a.at));

    return {
      code: formatWalletCode(wallet.shortCode ?? ''),
      balanceCents: wallet.balanceCents,
      status: wallet.status,
      closeRequested: wallet.closeRequestedAt !== null,
      hasFaceId,
      pending: pending
        ? {
            id: pending.id,
            amountCents: pending.amountCents,
            serviceName: pending.serviceName,
            requestedByName: requester?.displayName ?? 'El personal',
            venueName: venueName(pending.tenantId),
            expiresAt: pending.expiresAt.toISOString(),
          }
        : null,
      movements,
    };
  }

  /**
   * El cliente acepta: en una transacción con la wallet bloqueada se descuenta
   * el saldo, se apunta el consumo en el local donde se cobra y la parte de la
   * chica (con la comisión de esa categoría en ese local).
   */
  async accept(qrToken: string, requestId: string): Promise<ClientWalletState> {
    const wallet = await this.walletByToken(qrToken);
    // Con Face ID activado, el enlace ya no paga: aunque alguien lo tenga, sin
    // su móvil no puede gastar el saldo.
    if (await this.hasFaceId(wallet.id)) {
      throw new ForbiddenException('Tu saldo se paga con Face ID: escanea el QR del cobro');
    }
    // Sin local en el contexto y con bypass de RLS: la wallet, el consumo y la
    // parte de la chica pueden ser de locales distintos del grupo.
    await this.settleRequest(wallet.id, requestId);
    this.logger.log(`Saldo ${wallet.id}: cobro ${requestId} aceptado por el cliente`);
    return this.clientState(qrToken);
  }

  /**
   * Cobra un cobro pendiente de este saldo: con el saldo bloqueado se
   * descuenta, se apunta el consumo en el local donde se cobra y la parte de
   * la chica (con la comisión de esa categoría en ese local).
   */
  private async settleRequest(walletId: string, requestId: string, bind = false): Promise<void> {
    const wallet = { id: walletId };
    await this.prisma.acrossVenues(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string; balanceCents: number; status: string }>>`
        SELECT id, "balanceCents", status::text AS status FROM client_wallets WHERE id = ${wallet.id}::uuid FOR UPDATE
      `;
      const w = locked[0];
      if (bind && w) {
        // Cobro con QR: se ata a este saldo aquí mismo; si algo falla, el
        // rollback lo deja libre otra vez (nada queda atado a medias).
        const bound = await tx.walletChargeRequest.updateMany({
          where: { id: requestId, walletId: null, status: 'PENDING' },
          data: { walletId: wallet.id },
        });
        if (bound.count === 0) throw new ConflictException(REQUEST_ERRORS['not-pending']);
      }
      const request = await tx.walletChargeRequest.findFirst({ where: { id: requestId, walletId: wallet.id } });
      if (!w || !request) throw new NotFoundException('Cobro no encontrado');
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
    return {
      status: effectiveRequestStatus(request, new Date()),
      amountCents: request.amountCents,
      serviceName: request.serviceName,
      venueName: venue?.name ?? '',
      requestedByName: requester?.displayName ?? null,
      expiresAt: request.expiresAt.toISOString(),
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
    if (actor.role !== 'OWNER' && actor.role !== 'MANAGER') throw new ForbiddenException('Solo el encargado o el dueño');
    const now = new Date();
    const rows = await this.prisma.asSystem((tx) =>
      tx.walletChargeRequest.findMany({
        where: { tenantId: actor.tenantId, walletId: null, payToken: { not: null }, status: 'PENDING', expiresAt: { gt: now } },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
    );
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
        requestedByName: u?.displayName ?? u?.email ?? '',
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
      // Siempre en el mismo orden: dos fusiones a la vez no se bloquean entre sí.
      const ids = [sourceWalletId, targetWalletId].sort();
      const rows = await tx.$queryRaw<
        Array<{ id: string; tenantId: string; walletGroup: string | null; balanceCents: number; status: string }>
      >`
        SELECT id, "tenantId", "walletGroup", "balanceCents", status::text AS status
          FROM client_wallets WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE
      `;
      const source = rows.find((r) => r.id === sourceWalletId);
      const target = rows.find((r) => r.id === targetWalletId);
      if (!source || !target) throw new NotFoundException('Saldo no encontrado');
      if (!sameWalletGroup(target, { id: source.tenantId, walletGroup: source.walletGroup })) {
        throw new ConflictException('Ese saldo es de otro local: no se pueden juntar');
      }
      if (source.status !== 'ACTIVE' || source.balanceCents <= 0) throw new ConflictException('Esta recarga ya no se puede sumar');
      if (target.status !== 'ACTIVE' && target.status !== 'DEPLETED') throw new ConflictException('Tu saldo está cerrado');
      const keys = await tx.walletPasskey.count({ where: { walletId: sourceWalletId } });
      if (keys > 0) throw new ConflictException('Esta recarga ya tiene su propio Face ID');
      const open = await tx.payment.count({
        where: { walletId: sourceWalletId, status: { in: ['CREATED', 'AWAITING_CAPTURE', 'AUTHORIZING'] } },
      });
      if (open > 0) throw new ConflictException('Esta recarga tiene otro pago a medias: inténtalo en unos minutos');
      await tx.clientWallet.update({
        where: { id: targetWalletId },
        data: { balanceCents: { increment: source.balanceCents }, status: 'ACTIVE' },
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
  async payQrChargeWithPin(actor: Actor, requestId: string, input: { code: string; pin: string }): Promise<ChargeRequestView> {
    const request = await this.prisma.asSystem((tx) =>
      tx.walletChargeRequest.findFirst({ where: { id: requestId, tenantId: actor.tenantId, payToken: { not: null } } }),
    );
    if (!request) throw new NotFoundException('Cobro no encontrado');
    const manager = actor.role === 'MANAGER' || actor.role === 'OWNER';
    if (request.requestedByUserId !== actor.userId && !manager) {
      throw new ForbiddenException('Este cobro lo ha hecho otra persona');
    }
    // Que no se gaste un intento de PIN en un cobro que ya no se puede pagar.
    if (effectiveRequestStatus(request, new Date()) !== 'PENDING' || request.walletId) {
      throw new ConflictException(REQUEST_ERRORS['not-pending']);
    }
    const wallet = await this.walletByCode(actor.tenantId, input.code);
    // Un PIN que puso el encargado sin el cliente: ni él cobra con ese PIN ni
    // aprueba un cobro suyo (hacen falta dos personas, como sin Face ID).
    if (wallet.pinSetById && (wallet.pinSetById === actor.userId || wallet.pinSetById === request.requestedByUserId)) {
      throw new ForbiddenException('Este PIN lo pusiste tú: el cobro lo tiene que hacer otra persona');
    }
    await this.checkPin(wallet.id, input.pin, actor);
    await this.bindAndSettle(request, wallet.id);
    this.logger.log(`Saldo ${wallet.id}: cobro ${request.id} pagado con PIN (${actor.userId})`);
    return this.getRequest(actor, requestId);
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
    if (!fresh && actor.role !== 'MANAGER' && actor.role !== 'OWNER') {
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
  private async checkPin(walletId: string, pin: string, actor: Actor): Promise<void> {
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
        payload: { attemptsLeft: outcome.left },
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
    const first = await this.prisma.acrossVenues((tx) =>
      tx.payment.findFirst({
        where: { walletId },
        orderBy: { createdAt: 'asc' },
        select: { createdByUserId: true, authorizedAt: true },
      }),
    );
    return (
      first !== null &&
      first.createdByUserId === userId &&
      first.authorizedAt !== null &&
      first.authorizedAt.getTime() >= Date.now() - FRESH_TOPUP_PIN_MS
    );
  }

  /** Ata un cobro con QR a un saldo y lo cobra (todo o nada: si falla, el cobro sigue libre). */
  private async bindAndSettle(
    request: { id: string; tenantId: string; status: string; expiresAt: Date; walletId: string | null },
    walletId: string,
  ): Promise<void> {
    if (effectiveRequestStatus(request, new Date()) !== 'PENDING' || request.walletId) {
      throw new ConflictException(REQUEST_ERRORS['not-pending']);
    }
    const [wallet, venue] = await Promise.all([
      this.prisma.acrossVenues((tx) =>
        tx.clientWallet.findUnique({ where: { id: walletId }, select: { tenantId: true, walletGroup: true } }),
      ),
      this.prisma.venue.findUnique({ where: { id: request.tenantId }, select: { walletGroup: true } }),
    ]);
    if (!wallet || !sameWalletGroup(wallet, { id: request.tenantId, walletGroup: venue?.walletGroup ?? null })) {
      throw new ConflictException('Tu saldo no vale en este local');
    }
    await this.settleRequest(walletId, request.id, true);
  }

  private async hasFaceId(walletId: string): Promise<boolean> {
    const keys = await this.prisma.acrossVenues((tx) => tx.walletPasskey.count({ where: { walletId } }));
    return keys > 0;
  }

  private async qrRequest(payToken: string) {
    const request = await this.prisma.acrossVenues((tx) => tx.walletChargeRequest.findUnique({ where: { payToken } }));
    if (!request) throw new NotFoundException('Cobro no encontrado');
    return request;
  }

  private async managerWallet(actor: Actor, walletId: string): Promise<void> {
    if (actor.role !== 'OWNER' && actor.role !== 'MANAGER') {
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

  async reject(qrToken: string, requestId: string): Promise<ClientWalletState> {
    const wallet = await this.walletByToken(qrToken);
    const res = await this.prisma.asSystem((tx) =>
      tx.walletChargeRequest.updateMany({
        where: { id: requestId, walletId: wallet.id, status: 'PENDING' },
        data: { status: 'REJECTED', decidedAt: new Date() },
      }),
    );
    if (res.count === 0) throw new ConflictException('Este cobro ya no está pendiente');
    return this.clientState(qrToken);
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
   *  - CASH: en efectivo en el local (dueño o encargado).
   *  - CARD: ya hecho en el portal de BBVA (solo el dueño): se reparte entre
   *    las recargas y se apunta como devolución de cada una.
   */
  async payout(
    actor: Actor,
    walletId: string,
    input: { method: WalletPayoutMethod; bankReference?: string; note?: string },
  ): Promise<{ refundedCents: number; method: WalletPayoutMethod }> {
    if (input.method === 'CARD' && actor.role !== 'OWNER') {
      throw new ForbiddenException('La devolución a la tarjeta la registra el dueño (se hace en el portal de BBVA)');
    }
    if (input.method === 'CASH' && actor.role !== 'OWNER' && actor.role !== 'MANAGER') {
      throw new ForbiddenException('Devolver en efectivo lo hace el encargado');
    }
    const venue = await this.prisma.venue.findUnique({ where: { id: actor.tenantId }, select: { walletGroup: true } });
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

    // 1) Se congela el saldo: mientras se devuelve no se puede gastar.
    const frozen = await this.prisma.acrossVenues(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ balanceCents: number; status: string }>>`
        SELECT "balanceCents", status::text AS status FROM client_wallets WHERE id = ${walletId}::uuid FOR UPDATE
      `;
      const w = rows[0];
      if (!w || w.status !== 'ACTIVE' || w.balanceCents <= 0) {
        throw new ConflictException('Este saldo no tiene nada que devolver');
      }
      await tx.clientWallet.update({ where: { id: walletId }, data: { status: 'REFUNDED' } });
      await tx.walletChargeRequest.updateMany({
        where: { walletId, status: 'PENDING' },
        data: { status: 'CANCELED', decidedAt: new Date() },
      });
      return w.balanceCents;
    });

    // 2) Tarjeta: una devolución apuntada por recarga (ya hecha en BBVA).
    let refunded = 0;
    try {
      refunded = input.method === 'CARD' ? await this.refundToCard(actor, walletId, frozen, input.bankReference) : frozen;
    } finally {
      // 3) Se descuenta lo devuelto; si faltó algo, la wallet vuelve a abrirse con el resto.
      await this.settlePayout(actor, walletId, frozen, refunded, input);
    }
    const remaining = frozen - refunded;
    await this.audit.log({
      action: 'wallet.payout',
      tenantId: actor.tenantId,
      actorId: actor.userId,
      targetType: 'ClientWallet',
      targetId: walletId,
      payload: { method: input.method, refundedCents: refunded, remainingCents: remaining },
    });
    if (remaining > 0) {
      throw new ConflictException(
        `Se apuntaron ${eur(refunded)}; quedan ${eur(remaining)} que las recargas no cubren. Devuélvelos en efectivo.`,
      );
    }
    return { refundedCents: refunded, method: input.method };
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

  private async settlePayout(
    actor: Actor,
    walletId: string,
    frozen: number,
    refunded: number,
    input: { method: WalletPayoutMethod; bankReference?: string; note?: string },
  ): Promise<void> {
    const remaining = frozen - refunded;
    await this.prisma.acrossVenues(async (tx) => {
      await tx.clientWallet.update({
        where: { id: walletId },
        data: { balanceCents: remaining, status: remaining > 0 ? 'ACTIVE' : 'REFUNDED' },
      });
      if (refunded > 0) {
        await tx.walletPayout.create({
          data: {
            tenantId: actor.tenantId,
            walletId,
            amountCents: refunded,
            method: input.method,
            bankReference: input.bankReference ?? null,
            note: input.note ?? null,
            paidByUserId: actor.userId,
          },
        });
      }
    });
  }

  private async refundToCard(actor: Actor, walletId: string, amountCents: number, bankReference?: string): Promise<number> {
    const topUps = await this.prisma.acrossVenues((tx) =>
      tx.payment.findMany({
        where: { walletId, status: { in: ['AUTHORIZED', 'PARTIALLY_REFUNDED'] }, availableAmountCents: { gt: 0 } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, availableAmountCents: true },
      }),
    );
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

  private refunds(): RefundsService {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.moduleRef.get('RefundsService' as any, { strict: false }) as RefundsService;
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

  private async pendingOf(walletId: string) {
    const now = new Date();
    return this.prisma.acrossVenues((tx) =>
      tx.walletChargeRequest.findFirst({
        where: { walletId, status: 'PENDING', expiresAt: { gt: now } },
        orderBy: { createdAt: 'desc' },
      }),
    );
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

/** La chica o el camarero ponen el primer PIN solo en los 15 min tras la recarga. */
const FRESH_TOPUP_PIN_MS = 15 * 60 * 1000;

/** Fallos de PIN más viejos que esto ya no cuentan para el bloqueo. */
const PIN_FAILS_EXPIRE_MS = 12 * 60 * 60 * 1000;

/** La clave del servidor con la que se mezcla el PIN (no está en la base). */
function pinPepper(): string {
  const kek = process.env.ENCRYPTION_KEK;
  if (!kek || kek.length < 32) throw new Error('ENCRYPTION_KEK no configurada: no se puede comprobar el PIN');
  return kek;
}

function eur(cents: number): string {
  return `${(cents / 100).toFixed(2).replace('.', ',')} €`;
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
