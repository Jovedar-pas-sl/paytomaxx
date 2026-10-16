import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  isWalletCardToken,
  normalizeWalletCardUid,
  type CustomerMovement,
  type CustomerSearchResult,
  type CustomerWalletDetail,
  type ReasonOnlyDto,
  type RelinkResponse,
  type StepUpWithReasonDto,
} from '@nightpay/contracts';
import type { ClientWallet } from '@nightpay/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { formatWalletCode, normalizeWalletCode, WALLET_CODE_LENGTH } from '../wallets/wallet-rules';
import { WalletChargesService } from '../wallets/wallet-charges.service';
import { SuperAdminStepUpService } from './step-up.service';
import { SuperAdminAuditService } from './superadmin-audit.service';
import type { SuperAdminActor } from './superadmin.guard';

const WALLET_NOT_FOUND = 'Saldo no encontrado';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RESULTS = 50;
const MOVEMENTS = 50;

type MatchKind = CustomerSearchResult['matchedBy'];

const CATEGORY_LABELS: Record<string, string> = {
  CHICA_SERVICE: 'Servicio',
  VENUE_BAR: 'Barra',
  VENUE_ROOM: 'Habitación',
  VENUE_FOOD: 'Comida',
  EXTRA: 'Otro',
};

/**
 * Clientes con saldo de TODOS los locales: buscar por código, ficha NFC
 * (código grabado o número de serie), id del saldo o id de un cobro; ver su
 * saldo y movimientos; bloquear/desbloquear, desbloquear el PIN y darle un
 * enlace nuevo. client_wallets y wallet_consumptions tienen FORCE RLS: todo
 * con acrossVenues. Desbloquear el PIN y el enlace nuevo reutilizan
 * WalletChargesService (como el dueño del local donde se cargó).
 */
@Injectable()
export class SuperAdminCustomersService {
  private readonly prisma: PrismaService;
  private readonly stepUp: SuperAdminStepUpService;
  private readonly audit: SuperAdminAuditService;
  private readonly charges: WalletChargesService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(SuperAdminStepUpService) stepUp: SuperAdminStepUpService,
    @Inject(SuperAdminAuditService) audit: SuperAdminAuditService,
    @Inject(WalletChargesService) charges: WalletChargesService,
  ) {
    this.prisma = prisma;
    this.stepUp = stepUp;
    this.audit = audit;
    this.charges = charges;
  }

  async search(rawQuery: string): Promise<CustomerSearchResult[]> {
    const q = rawQuery.trim();
    const matches = await this.prisma.acrossVenues(async (tx) => {
      const found: Array<{ wallet: ClientWallet; matchedBy: MatchKind }> = [];
      const add = (wallets: ClientWallet[], matchedBy: MatchKind) => {
        for (const wallet of wallets) found.push({ wallet, matchedBy });
      };
      const code = normalizeWalletCode(q);
      if (code.length === WALLET_CODE_LENGTH) {
        add(await tx.clientWallet.findMany({ where: { shortCode: code }, orderBy: { createdAt: 'desc' }, take: MAX_RESULTS }), 'shortCode');
      }
      if (UUID_RE.test(q)) {
        const id = q.toLowerCase();
        const byId = await tx.clientWallet.findUnique({ where: { id } });
        if (byId) add([byId], 'walletId');
        const payment = await tx.payment.findUnique({ where: { id }, select: { walletId: true } });
        if (payment?.walletId) {
          const w = await tx.clientWallet.findUnique({ where: { id: payment.walletId } });
          if (w) add([w], 'paymentId');
        }
      }
      if (isWalletCardToken(q)) {
        const card = await tx.walletCard.findUnique({ where: { token: q }, select: { walletId: true } });
        if (card?.walletId) add(await tx.clientWallet.findMany({ where: { id: card.walletId } }), 'cardToken');
      }
      const uid = normalizeWalletCardUid(q);
      if (uid) {
        const cards = await tx.walletCard.findMany({ where: { uid, walletId: { not: null } }, select: { walletId: true }, take: MAX_RESULTS });
        const ids = cards.map((c) => c.walletId).filter((id): id is string => id !== null);
        if (ids.length > 0) add(await tx.clientWallet.findMany({ where: { id: { in: ids } } }), 'cardUid');
      }
      return found;
    });

    const unique = [...new Map(matches.map((m) => [m.wallet.id, m])).values()].slice(0, MAX_RESULTS);
    const venueNames = await this.venueNames(unique.map((m) => m.wallet.tenantId));
    return unique.map(({ wallet: w, matchedBy }) => ({
      walletId: w.id,
      code: w.shortCode ? formatWalletCode(w.shortCode) : null,
      status: w.status,
      balanceCents: w.balanceCents,
      walletGroup: w.walletGroup,
      homeVenue: { id: w.tenantId, name: venueNames.get(w.tenantId) ?? '' },
      blocked: w.blockedAt !== null,
      matchedBy,
      createdAt: w.createdAt.toISOString(),
    }));
  }

  async detail(walletId: string): Promise<CustomerWalletDetail> {
    const data = await this.prisma.acrossVenues(async (tx) => {
      const wallet = await tx.clientWallet.findUnique({ where: { id: walletId } });
      if (!wallet) throw new NotFoundException(WALLET_NOT_FOUND);
      // Una detrás de otra: es la misma transacción (una sola conexión).
      const passkeys = await tx.walletPasskey.count({ where: { walletId } });
      const activeCards = await tx.walletCard.count({ where: { walletId, status: 'ACTIVE' } });
      const blockedCards = await tx.walletCard.count({ where: { walletId, status: 'BLOCKED' } });
      const topUps = await tx.payment.findMany({
        where: { walletId },
        orderBy: { createdAt: 'desc' },
        take: MOVEMENTS,
        select: { id: true, tenantId: true, amountCents: true, status: true, authorizedAt: true, createdAt: true },
      });
      const consumptions = await tx.walletConsumption.findMany({
        where: { walletId },
        orderBy: { createdAt: 'desc' },
        take: MOVEMENTS,
        select: { id: true, tenantId: true, amountCents: true, tipCents: true, category: true, notes: true, reversedAt: true, createdAt: true },
      });
      const payouts = await tx.walletPayout.findMany({
        where: { walletId },
        orderBy: { createdAt: 'desc' },
        take: MOVEMENTS,
        select: { id: true, tenantId: true, amountCents: true, method: true, status: true, createdAt: true },
      });
      return { wallet, passkeys, activeCards, blockedCards, topUps, consumptions, payouts };
    });
    const { wallet: w } = data;
    const names = await this.venueNames([
      w.tenantId,
      ...data.topUps.map((t) => t.tenantId),
      ...data.consumptions.map((c) => c.tenantId),
      ...data.payouts.map((p) => p.tenantId),
    ]);
    const venue = (id: string) => ({ id, name: names.get(id) ?? '' });
    const movements: CustomerMovement[] = [
      ...data.topUps.map((t) => ({
        kind: 'topup' as const,
        id: t.id,
        amountCents: t.amountCents,
        status: t.status,
        label: 'Recarga',
        venue: venue(t.tenantId),
        at: (t.authorizedAt ?? t.createdAt).toISOString(),
      })),
      ...data.consumptions.map((c) => ({
        kind: 'consumption' as const,
        id: c.id,
        amountCents: -(c.amountCents + c.tipCents),
        status: c.reversedAt ? 'REVERSED' : 'OK',
        label: c.notes?.split('\n')[0]?.trim() || CATEGORY_LABELS[c.category] || 'Consumo',
        venue: venue(c.tenantId),
        at: c.createdAt.toISOString(),
      })),
      ...data.payouts.map((p) => ({
        kind: 'payout' as const,
        id: p.id,
        amountCents: -p.amountCents,
        status: p.status,
        label: p.method === 'CASH' ? 'Devuelto en efectivo' : 'Devuelto a la tarjeta',
        venue: venue(p.tenantId),
        at: p.createdAt.toISOString(),
      })),
    ]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, MOVEMENTS);

    return {
      walletId: w.id,
      code: w.shortCode ? formatWalletCode(w.shortCode) : null,
      label: w.identifier,
      status: w.status,
      balanceCents: w.balanceCents,
      walletGroup: w.walletGroup,
      homeVenue: venue(w.tenantId),
      blocked: w.blockedAt !== null,
      blockedAt: w.blockedAt?.toISOString() ?? null,
      blockedReason: w.blockedReason,
      closeRequestedAt: w.closeRequestedAt?.toISOString() ?? null,
      mergedIntoId: w.mergedIntoId,
      passkeysCount: data.passkeys,
      cards: { active: data.activeCards, blocked: data.blockedCards },
      pin: { hasPin: w.pinHash !== null, locked: w.pinLockedAt !== null, fails: w.pinFails },
      createdAt: w.createdAt.toISOString(),
      movements,
    };
  }

  /** Bloquear: el saldo no paga (protege, sin 2FA). Se le puede seguir devolviendo. */
  async block(actor: SuperAdminActor, walletId: string, dto: ReasonOnlyDto): Promise<CustomerWalletDetail> {
    const wallet = await this.load(walletId);
    const blockedAt = new Date();
    const res = await this.prisma.acrossVenues((tx) =>
      tx.clientWallet.updateMany({ where: { id: walletId, blockedAt: null }, data: { blockedAt, blockedReason: dto.reason } }),
    );
    if (res.count === 0) throw new ConflictException('Este saldo ya está bloqueado');
    await this.audit.write(actor, {
      action: 'wallet.blocked',
      tenantId: wallet.tenantId,
      targetType: 'ClientWallet',
      targetId: walletId,
      before: { blockedAt: null },
      after: { blockedAt },
      reason: dto.reason,
      extra: { balanceCents: wallet.balanceCents },
    });
    return this.detail(walletId);
  }

  async unblock(actor: SuperAdminActor, walletId: string, dto: StepUpWithReasonDto): Promise<CustomerWalletDetail> {
    await this.stepUp.verify(actor, dto.totpCode, 'wallet.unblock');
    const wallet = await this.load(walletId);
    if (!wallet.blockedAt) throw new ConflictException('Este saldo no está bloqueado');
    await this.prisma.acrossVenues((tx) =>
      tx.clientWallet.update({ where: { id: walletId }, data: { blockedAt: null, blockedReason: null } }),
    );
    await this.audit.write(actor, {
      action: 'wallet.unblocked',
      tenantId: wallet.tenantId,
      targetType: 'ClientWallet',
      targetId: walletId,
      before: { blockedAt: wallet.blockedAt, blockedReason: wallet.blockedReason },
      after: { blockedAt: null },
      reason: dto.reason,
    });
    return this.detail(walletId);
  }

  /** Tras 5 PIN fallidos (como el encargado): WalletChargesService.unlockPin (2FA). */
  async unlockPin(actor: SuperAdminActor, walletId: string, dto: StepUpWithReasonDto): Promise<CustomerWalletDetail> {
    await this.stepUp.verify(actor, dto.totpCode, 'wallet.unlock_pin');
    const wallet = await this.load(walletId);
    if (!wallet.pinLockedAt) throw new ConflictException('El PIN de este saldo no está bloqueado');
    await this.charges.unlockPin(this.asHomeOwner(actor, wallet), walletId);
    await this.audit.write(actor, {
      action: 'wallet.pin_unlocked',
      tenantId: wallet.tenantId,
      targetType: 'ClientWallet',
      targetId: walletId,
      before: { pinLocked: true, pinFails: wallet.pinFails },
      after: { pinLocked: false, pinFails: 0 },
      reason: dto.reason,
    });
    return this.detail(walletId);
  }

  /**
   * Enlace nuevo del saldo (el cliente perdió el suyo): el viejo deja de valer
   * y sus llaves (Face ID) se borran. WalletChargesService.relink (2FA). El
   * enlace es la credencial del cliente: no va al registro.
   */
  async relink(actor: SuperAdminActor, walletId: string, dto: StepUpWithReasonDto): Promise<RelinkResponse> {
    await this.stepUp.verify(actor, dto.totpCode, 'wallet.relink');
    const wallet = await this.load(walletId);
    const passkeys = await this.prisma.acrossVenues((tx) => tx.walletPasskey.count({ where: { walletId } }));
    const { path } = await this.charges.relink(this.asHomeOwner(actor, wallet), walletId);
    await this.audit.write(actor, {
      action: 'wallet.relinked',
      tenantId: wallet.tenantId,
      targetType: 'ClientWallet',
      targetId: walletId,
      reason: dto.reason,
      extra: { removedPasskeys: passkeys, balanceCents: wallet.balanceCents },
    });
    return { path, removedPasskeys: passkeys };
  }

  /** Para los servicios del saldo: como el dueño del local donde se cargó (mismo grupo siempre). */
  private asHomeOwner(actor: SuperAdminActor, wallet: ClientWallet) {
    return { userId: actor.id, role: 'OWNER' as const, tenantId: wallet.tenantId };
  }

  private async load(walletId: string): Promise<ClientWallet> {
    const wallet = await this.prisma.acrossVenues((tx) => tx.clientWallet.findUnique({ where: { id: walletId } }));
    if (!wallet) throw new NotFoundException(WALLET_NOT_FOUND);
    return wallet;
  }

  private async venueNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const venues = await this.prisma.acrossVenues((tx) =>
      tx.venue.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } }),
    );
    return new Map(venues.map((v) => [v.id, v.name]));
  }
}
