import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import type { PromoterView } from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { isPayeeRole } from '../operators/payee-roles';
import { ReservationCatalogService } from './reservation-catalog.service';
import type { StaffActor } from './reservation-ops.service';
import { newPromoterCode, promoterCommissionCents } from './reservation-rules';

const MAX_CODE_ATTEMPTS = 5;

/**
 * RRPP: una persona del equipo (compañera o camarero: cobran en el reparto de
 * siempre) con su % del paquete (distinto para cada una; no hay % general) y
 * su enlace (/reservar/<código de 12 letras>). Lo que vende queda con
 * «vendido por» y su % de ese momento en cada reserva; la comisión se gana con
 * el paquete pagado entero (reservation-ledger). El % lo pone el dueño.
 */
@Injectable()
export class PromotersService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ReservationCatalogService) private readonly catalog: ReservationCatalogService,
  ) {}

  async list(actor: StaffActor): Promise<PromoterView[]> {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const rows = await tx.promoter.findMany({
        where: { tenantId: actor.tenantId },
        include: { user: { select: { displayName: true, email: true } } },
        orderBy: [{ active: 'desc' }, { createdAt: 'asc' }],
      });
      const sold = await tx.reservation.findMany({
        where: { tenantId: actor.tenantId, promoterId: { in: rows.map((p) => p.id) }, commissionEarnedAt: { not: null } },
        select: { promoterId: true, priceCents: true, promoterBps: true },
      });
      return rows.map((p) => {
        const mine = sold.filter((s) => s.promoterId === p.id);
        return {
          id: p.id,
          userId: p.userId,
          name: p.user.displayName ?? p.user.email,
          commissionBps: p.commissionBps,
          active: p.active,
          url: `${this.catalog.origin}/reservar/${p.code}`,
          soldCount: mine.length,
          commissionCents: mine.reduce((a, s) => a + promoterCommissionCents(s.priceCents, s.promoterBps ?? 0), 0),
        };
      });
    });
  }

  /** Alta: una persona del equipo que cobra en el reparto (compañera o camarero). */
  async create(actor: StaffActor, input: { userId: string; commissionBps: number }): Promise<PromoterView> {
    this.assertOwner(actor);
    const user = await this.prisma.withTenant(actor.tenantId, (tx) =>
      tx.user.findFirst({ where: { id: input.userId, tenantId: actor.tenantId, deletedAt: null }, select: { id: true, role: true } }),
    );
    if (!user) throw new NotFoundException('Esa persona no es de este local');
    if (!isPayeeRole(user.role)) throw new BadRequestException('El RRPP tiene que ser una compañera o un camarero: cobran en el reparto');
    const already = () =>
      this.prisma.withTenant(actor.tenantId, (tx) => tx.promoter.count({ where: { tenantId: actor.tenantId, userId: user.id } }));
    if ((await already()) > 0) throw new ConflictException('Esa persona ya es RRPP');
    for (let attempt = 1; ; attempt += 1) {
      try {
        const row = await this.prisma.withTenant(actor.tenantId, (tx) =>
          tx.promoter.create({ data: { tenantId: actor.tenantId, userId: user.id, commissionBps: input.commissionBps, code: newPromoterCode() } }),
        );
        await this.audit.log({ action: 'promoter.created', tenantId: actor.tenantId, actorId: actor.userId, targetType: 'Promoter', targetId: row.id, payload: { userId: user.id, commissionBps: input.commissionBps } });
        return this.one(actor, row.id);
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
        // Dos altas a la vez de la misma persona, o (muy raro) un código repetido: se reintenta.
        if ((await already()) > 0) throw new ConflictException('Esa persona ya es RRPP');
        if (attempt >= MAX_CODE_ATTEMPTS) throw err;
      }
    }
  }

  /** Cambiar su % (las reservas ya vendidas guardan el de su momento) o darle de baja (su enlace deja de valer). */
  async update(actor: StaffActor, id: string, patch: { commissionBps?: number; active?: boolean }): Promise<PromoterView> {
    this.assertOwner(actor);
    await this.prisma.withTenant(actor.tenantId, async (tx) => {
      const found = await tx.promoter.findFirst({ where: { id, tenantId: actor.tenantId }, select: { id: true } });
      if (!found) throw new NotFoundException('RRPP no encontrado');
      await tx.promoter.update({ where: { id }, data: patch });
    });
    await this.audit.log({ action: 'promoter.updated', tenantId: actor.tenantId, actorId: actor.userId, targetType: 'Promoter', targetId: id, payload: { ...patch } });
    return this.one(actor, id);
  }

  private async one(actor: StaffActor, id: string): Promise<PromoterView> {
    const found = (await this.list(actor)).find((p) => p.id === id);
    if (!found) throw new NotFoundException('RRPP no encontrado');
    return found;
  }

  private assertOwner(actor: StaffActor): void {
    if (actor.role !== 'OWNER') throw new ForbiddenException('El % de los RRPP lo pone el dueño');
  }
}
