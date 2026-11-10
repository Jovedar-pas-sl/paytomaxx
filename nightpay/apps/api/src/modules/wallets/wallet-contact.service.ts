import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { normalizeContactPhone, type WalletByPhone } from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { assertCanTopUp } from '../venues/charge-rights';
import { FRESH_TOPUP_MS } from './wallet-fresh-topup';
import { formatWalletCode, sameWalletGroup } from './wallet-rules';

type Actor = { userId: string; role: string; tenantId: string };

const manager = (actor: Actor) => actor.role === 'MANAGER' || actor.role === 'OWNER';

/**
 * El teléfono opcional del cliente al darle una ficha nueva: solo para
 * encontrar su saldo si lo pierde todo (la ficha y el código). Dato personal:
 *  - lo deja quien le acaba de dar la ficha (en los 15 min siguientes) o el
 *    encargado o el dueño;
 *  - no sale en ninguna lista; lo ven el encargado y el dueño en el detalle
 *    del saldo y lo buscan por él;
 *  - en el registro, que se puso, nunca el número.
 */
@Injectable()
export class WalletContactService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async setPhone(actor: Actor, walletId: string, raw: string, now: Date = new Date()): Promise<{ ok: true }> {
    await this.prisma.asSystem((tx) => assertCanTopUp(tx, actor.tenantId, actor));
    const phone = normalizeContactPhone(raw);
    if (!phone) throw new BadRequestException({ message: 'Ese teléfono no parece bien: escribe solo las cifras (con el prefijo si es de fuera).', code: 'PHONE_FORMAT' });
    await this.assertOfVenue(actor.tenantId, walletId);
    if (!manager(actor)) {
      // Solo al darle la ficha nueva: quien se la dio, en sus 15 minutos.
      const given = await this.prisma.acrossVenues((tx) =>
        tx.walletCardEvent.findFirst({
          where: { walletId, kind: 'ISSUED', byUserId: actor.userId, at: { gte: new Date(now.getTime() - FRESH_TOPUP_MS) } },
          select: { id: true },
        }),
      );
      if (!given) throw new ForbiddenException('El teléfono se deja al darle la ficha nueva: después, con el encargado.');
    }
    await this.prisma.acrossVenues((tx) => tx.clientWallet.update({ where: { id: walletId }, data: { contactPhone: phone } }));
    await this.audit.log({
      action: 'wallet.contact_phone_set',
      tenantId: actor.tenantId,
      actorId: actor.userId,
      targetType: 'ClientWallet',
      targetId: walletId,
      payload: { by: manager(actor) ? 'manager' : 'reception' },
    });
    return { ok: true };
  }

  /** Encargado o dueño: los saldos de su local (o su grupo) con ese teléfono. */
  async findByPhone(actor: Actor, raw: string): Promise<WalletByPhone[]> {
    if (!manager(actor)) throw new ForbiddenException('Solo el encargado o el dueño');
    const phone = normalizeContactPhone(raw);
    if (!phone) throw new BadRequestException({ message: 'Ese teléfono no parece bien: escribe solo las cifras.', code: 'PHONE_FORMAT' });
    const venue = await this.prisma.venue.findUnique({ where: { id: actor.tenantId }, select: { walletGroup: true } });
    const here = { id: actor.tenantId, walletGroup: venue?.walletGroup ?? null };
    const rows = await this.prisma.acrossVenues((tx) =>
      tx.clientWallet.findMany({
        where: { contactPhone: phone, mergedIntoId: null },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, tenantId: true, walletGroup: true, shortCode: true, balanceCents: true, status: true, createdAt: true },
      }),
    );
    await this.audit.log({
      action: 'wallet.contact_phone_search',
      tenantId: actor.tenantId,
      actorId: actor.userId,
      targetType: 'ClientWallet',
      targetId: actor.tenantId,
      payload: { found: rows.length },
    });
    return rows
      .filter((w) => sameWalletGroup(w, here))
      .map((w) => ({ walletId: w.id, code: formatWalletCode(w.shortCode ?? ''), balanceCents: w.balanceCents, status: w.status, createdAt: w.createdAt.toISOString() }));
  }

  private async assertOfVenue(venueId: string, walletId: string): Promise<void> {
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId }, select: { walletGroup: true } });
    const wallet = await this.prisma.acrossVenues((tx) =>
      tx.clientWallet.findUnique({ where: { id: walletId }, select: { tenantId: true, walletGroup: true, status: true } }),
    );
    if (!wallet || !sameWalletGroup(wallet, { id: venueId, walletGroup: venue?.walletGroup ?? null })) {
      throw new NotFoundException('Saldo no encontrado');
    }
  }
}