import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Role } from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { resolveBpsForOperator, resolveRevenueCategory, type RevenueCategory } from '../payments/commission';
import { applyServiceItem } from '../payments/service-item';
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
import { PIN_MAX_FAILS, PIN_PROBLEM_TEXT, hashPin, normalizeNfcTag, pinProblem, verifyPin } from './wallet-pin';

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
  /** El cliente ya eligió su PIN (si no, lo elige antes de cobrar). */
  hasPin: boolean;
  /** 5 PIN fallidos: bloqueado hasta que lo desbloquee el encargado. */
  pinLocked: boolean;
  /** Tiene pulsera o tarjeta NFC. */
  hasTag: boolean;
}

/** Cómo encuentra la chica el saldo: el código o la pulsera NFC. */
export interface WalletRefInput {
  code?: string;
  tag?: string;
}

export interface ChargeRequestView {
  id: string;
  status: ChargeRequestStatus;
  amountCents: number;
  serviceName: string | null;
  expiresAt: string;
  newBalanceCents: number | null;
}

export interface ClientWalletState {
  code: string;
  balanceCents: number;
  status: string;
  closeRequested: boolean;
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

  /** Por su id (la recarga recién cobrada); de este local o de otro del grupo. */
  async lookupById(venueId: string, walletId: string): Promise<WalletLookup> {
    const [wallet, venue] = await Promise.all([
      this.prisma.acrossVenues((tx) => tx.clientWallet.findUnique({ where: { id: walletId } })),
      this.prisma.venue.findUnique({ where: { id: venueId }, select: { walletGroup: true } }),
    ]);
    if (!wallet || !sameWalletGroup(wallet, { id: venueId, walletGroup: venue?.walletGroup ?? null })) {
      throw new NotFoundException('Saldo no encontrado');
    }
    return this.lookupWallet(venueId, wallet);
  }

  /** La chica acerca la pulsera NFC del cliente. */
  async lookupByTag(venueId: string, rawTag: string): Promise<WalletLookup> {
    return this.lookupWallet(venueId, await this.walletByTag(venueId, rawTag));
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
      hasTag: wallet.nfcTag !== null,
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
    return this.requestView(await this.openRequest(actor, wallet.id, input), null);
  }

  /** El cobro pedido (pendiente), con el precio de la carta o el importe tecleado. */
  private async openRequest(
    actor: Actor,
    walletId: string,
    input: { serviceItemId?: string; amountCents?: number; category?: string },
  ) {
    const wallet = { id: walletId };
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
    return request;
  }

  /** La chica espera la respuesta del cliente. */
  async getRequest(actor: Actor, requestId: string): Promise<ChargeRequestView> {
    const request = await this.prisma.asSystem((tx) =>
      tx.walletChargeRequest.findFirst({ where: { id: requestId, tenantId: actor.tenantId } }),
    );
    if (!request) throw new NotFoundException('Cobro no encontrado');
    const wallet = await this.prisma.acrossVenues((tx) =>
      tx.clientWallet.findUnique({ where: { id: request.walletId }, select: { balanceCents: true } }),
    );
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
    // Sin local en el contexto y con bypass de RLS: la wallet, el consumo y la
    // parte de la chica pueden ser de locales distintos del grupo.
    await this.settleRequest(wallet.id, requestId);
    this.logger.log(`Saldo ${wallet.id}: cobro ${requestId} aceptado por el cliente`);
    return this.clientState(qrToken);
  }

  /**
   * Cobra un cobro pendiente: en una transacción con el saldo bloqueado se
   * descuenta, se apunta el consumo en el local donde se cobra y la parte de
   * la chica (con la comisión de esa categoría en ese local).
   */
  private async settleRequest(walletId: string, requestId: string): Promise<void> {
    const wallet = { id: walletId };
    await this.prisma.acrossVenues(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string; balanceCents: number; status: string }>>`
        SELECT id, "balanceCents", status::text AS status FROM client_wallets WHERE id = ${wallet.id}::uuid FOR UPDATE
      `;
      const w = locked[0];
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

  // ─── PIN del cliente (cobrar sin su móvil) ─────────────────────────────

  /**
   * La chica cobra del saldo y el cliente pone su PIN en el móvil de ella. Si
   * el PIN es bueno, se cobra al momento (el mismo cobro que "Aceptar").
   */
  async chargeWithPin(
    actor: Actor,
    input: WalletRefInput & { serviceItemId?: string; amountCents?: number; pin: string },
  ): Promise<ChargeRequestView> {
    const wallet = await this.walletFor(actor.tenantId, input);
    await this.checkPin(wallet.id, input.pin);
    const request = await this.openRequest(actor, wallet.id, input);
    try {
      await this.settleRequest(wallet.id, request.id);
    } catch (err) {
      // No se pudo cobrar (saldo, cerrado…): el cobro no queda colgado.
      await this.prisma.acrossVenues((tx) =>
        tx.walletChargeRequest.updateMany({
          where: { id: request.id, status: 'PENDING' },
          data: { status: 'CANCELED', decidedAt: new Date() },
        }),
      );
      throw err;
    }
    this.logger.log(`Saldo ${wallet.id}: cobro ${request.id} con PIN por ${actor.userId}`);
    return this.getRequest(actor, request.id);
  }

  /**
   * El cliente elige su PIN en el móvil de la chica (si pagó en efectivo o
   * con el datáfono). Solo si aún no tiene: cambiarlo es cosa del encargado.
   */
  async setPin(actor: Actor, input: WalletRefInput & { pin: string }): Promise<WalletLookup> {
    const wallet = await this.walletFor(actor.tenantId, input);
    await this.storeFirstPin(wallet.id, input.pin);
    await this.audit.log({
      action: 'wallet.pin_set',
      tenantId: actor.tenantId,
      actorId: actor.userId,
      targetType: 'ClientWallet',
      targetId: wallet.id,
      payload: { where: 'staff-device' },
    });
    return this.lookupWallet(actor.tenantId, await this.walletFor(actor.tenantId, input));
  }

  /** El cliente elige su PIN en su propio móvil, en "Pagado" tras recargar. */
  async setPinByWalletToken(qrToken: string, pin: string): Promise<void> {
    const wallet = await this.walletByToken(qrToken);
    await this.storeFirstPin(wallet.id, pin);
    await this.audit.log({
      action: 'wallet.pin_set',
      tenantId: wallet.tenantId,
      targetType: 'ClientWallet',
      targetId: wallet.id,
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

  /** Encargado o dueño: el cliente olvidó su PIN → lo borra y el cliente elige otro. */
  async resetPin(actor: Actor, walletId: string): Promise<{ ok: true }> {
    await this.managerWallet(actor, walletId);
    await this.prisma.acrossVenues((tx) =>
      tx.clientWallet.update({ where: { id: walletId }, data: { pinHash: null, pinFails: 0, pinLockedAt: null } }),
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
   * Pulsera o tarjeta NFC para este saldo. Una pulsera de un saldo ya gastado
   * o cerrado se puede reutilizar; la de otro cliente con saldo, no.
   */
  async assignTag(actor: Actor, input: { code: string; tag: string }): Promise<WalletLookup> {
    const tag = normalizeNfcTag(input.tag);
    if (!tag) throw new BadRequestException('No se ha podido leer la pulsera: acércala otra vez');
    const wallet = await this.walletByCode(actor.tenantId, input.code);
    await this.prisma.acrossVenues(async (tx) => {
      const other = await tx.clientWallet.findUnique({
        where: { nfcTag: tag },
        select: { id: true, status: true, balanceCents: true },
      });
      if (other && other.id !== wallet.id) {
        if (other.status === 'ACTIVE' && other.balanceCents > 0) {
          throw new ConflictException('Esa pulsera es de otro cliente que aún tiene saldo');
        }
        await tx.clientWallet.update({ where: { id: other.id }, data: { nfcTag: null } });
      }
      await tx.clientWallet.update({ where: { id: wallet.id }, data: { nfcTag: tag } });
    });
    await this.audit.log({
      action: 'wallet.tag_assigned',
      tenantId: actor.tenantId,
      actorId: actor.userId,
      targetType: 'ClientWallet',
      targetId: wallet.id,
      payload: {},
    });
    return this.lookupWallet(actor.tenantId, await this.walletByCode(actor.tenantId, input.code));
  }

  /**
   * Comprueba el PIN con el saldo bloqueado (dos intentos a la vez no se
   * saltan el contador). Los fallos se guardan aunque el cobro no siga.
   */
  private async checkPin(walletId: string, pin: string): Promise<void> {
    const pepper = pinPepper();
    const outcome = await this.prisma.acrossVenues(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ pinHash: string | null; pinFails: number; pinLockedAt: Date | null }>>`
        SELECT "pinHash", "pinFails", "pinLockedAt" FROM client_wallets WHERE id = ${walletId}::uuid FOR UPDATE
      `;
      const w = rows[0];
      if (!w) return { kind: 'missing' as const };
      if (!w.pinHash) return { kind: 'no-pin' as const };
      if (w.pinLockedAt) return { kind: 'locked' as const };
      if (await verifyPin(pin, w.pinHash, pepper)) {
        if (w.pinFails > 0) await tx.clientWallet.update({ where: { id: walletId }, data: { pinFails: 0 } });
        return { kind: 'ok' as const };
      }
      const fails = w.pinFails + 1;
      const lock = fails >= PIN_MAX_FAILS;
      await tx.clientWallet.update({
        where: { id: walletId },
        data: { pinFails: fails, ...(lock ? { pinLockedAt: new Date() } : {}) },
      });
      return { kind: lock ? ('now-locked' as const) : ('wrong' as const), left: PIN_MAX_FAILS - fails };
    });
    switch (outcome.kind) {
      case 'ok':
        return;
      case 'missing':
        throw new NotFoundException('Saldo no encontrado');
      case 'no-pin':
        throw new ConflictException('El cliente aún no tiene PIN: que lo elija primero');
      case 'locked':
        throw new ForbiddenException('Saldo bloqueado por PIN fallado: avisa al encargado para desbloquearlo');
      case 'now-locked':
        this.logger.warn(`Saldo ${walletId}: bloqueado tras ${PIN_MAX_FAILS} PIN fallidos`);
        throw new ForbiddenException('PIN incorrecto. Saldo bloqueado: avisa al encargado para desbloquearlo');
      case 'wrong':
        throw new ForbiddenException(
          `PIN incorrecto. ${outcome.left === 1 ? 'Queda 1 intento' : `Quedan ${outcome.left} intentos`}`,
        );
    }
  }

  /** Guarda el primer PIN (si ya hay uno, solo el encargado lo puede borrar). */
  private async storeFirstPin(walletId: string, pin: string): Promise<void> {
    const problem = pinProblem(pin);
    if (problem) throw new BadRequestException(PIN_PROBLEM_TEXT[problem]);
    const pinHash = await hashPin(pin, pinPepper());
    const res = await this.prisma.acrossVenues((tx) =>
      tx.clientWallet.updateMany({ where: { id: walletId, pinHash: null }, data: { pinHash, pinFails: 0 } }),
    );
    if (res.count === 0) throw new ConflictException('Este saldo ya tiene PIN');
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
    await this.prisma.acrossVenues((tx) => tx.clientWallet.update({ where: { id: walletId }, data: { qrToken } }));
    await this.audit.log({
      action: 'wallet.relinked',
      tenantId: actor.tenantId,
      actorId: actor.userId,
      targetType: 'ClientWallet',
      targetId: walletId,
      payload: { balanceCents: wallet.balanceCents },
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
      // Activo primero; a 0 también (se puede recargar otra noche).
      this.prisma.acrossVenues((tx) =>
        tx.clientWallet.findFirst({
          where: { shortCode: code, status: { in: ['ACTIVE', 'DEPLETED'] } },
          orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        }),
      ),
      this.prisma.venue.findUnique({ where: { id: venueId }, select: { walletGroup: true } }),
    ]);
    if (!wallet || !sameWalletGroup(wallet, { id: venueId, walletGroup: venue?.walletGroup ?? null })) {
      throw new NotFoundException('No hay ningún saldo con ese código en este local');
    }
    return wallet;
  }

  private async walletByTag(venueId: string, rawTag: string) {
    const tag = normalizeNfcTag(rawTag);
    const [wallet, venue] = await Promise.all([
      tag ? this.prisma.acrossVenues((tx) => tx.clientWallet.findUnique({ where: { nfcTag: tag } })) : null,
      this.prisma.venue.findUnique({ where: { id: venueId }, select: { walletGroup: true } }),
    ]);
    if (
      !wallet ||
      (wallet.status !== 'ACTIVE' && wallet.status !== 'DEPLETED') ||
      !sameWalletGroup(wallet, { id: venueId, walletGroup: venue?.walletGroup ?? null })
    ) {
      throw new NotFoundException('Esa pulsera no tiene saldo en este local');
    }
    return wallet;
  }

  private async walletFor(venueId: string, input: WalletRefInput) {
    if (input.tag) return this.walletByTag(venueId, input.tag);
    if (input.code) return this.walletByCode(venueId, input.code);
    throw new BadRequestException('Falta el código o la pulsera del cliente');
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

/** Clave del servidor para el PIN (no está en la base). */
function pinPepper(): string {
  const kek = process.env.ENCRYPTION_KEK;
  if (!kek || kek.length < 32) throw new Error('ENCRYPTION_KEK no configurada: no se puede comprobar el PIN');
  return kek;
}
