import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@nightpay/db';
import type { AuditEventPage, AuditListQuery } from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { maskSensitive } from './masking';

/**
 * Registro (audit_events) de todos los locales, del más reciente al más
 * antiguo, paginado por id. Filtros: local, quién, prefijo de la acción y
 * fechas [from, to). El payload sale con lo secreto tapado.
 */
@Injectable()
export class SuperAdminAuditLogService {
  private readonly prisma: PrismaService;

  constructor(@Inject(PrismaService) prisma: PrismaService) {
    this.prisma = prisma;
  }

  async list(query: AuditListQuery): Promise<AuditEventPage> {
    const occurredAt: Prisma.DateTimeFilter = {
      ...(query.from ? { gte: new Date(query.from) } : {}),
      ...(query.to ? { lt: new Date(query.to) } : {}),
    };
    const where: Prisma.AuditEventWhereInput = {
      ...(query.venueId ? { tenantId: query.venueId } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.action ? { action: { startsWith: query.action } } : {}),
      ...(query.from || query.to ? { occurredAt } : {}),
      ...(query.cursor ? { id: { lt: BigInt(query.cursor) } } : {}),
    };
    const rows = await this.prisma.acrossVenues((tx) =>
      tx.auditEvent.findMany({ where, orderBy: { id: 'desc' }, take: query.limit + 1 }),
    );
    const page = rows.slice(0, query.limit);
    const venueIds = [...new Set(page.map((r) => r.tenantId).filter((id): id is string => id !== null))];
    const venues = venueIds.length
      ? await this.prisma.acrossVenues((tx) => tx.venue.findMany({ where: { id: { in: venueIds } }, select: { id: true, name: true } }))
      : [];
    const names = new Map(venues.map((v) => [v.id, v.name]));
    return {
      items: page.map((r) => ({
        id: r.id.toString(),
        occurredAt: r.occurredAt.toISOString(),
        action: r.action,
        venue: r.tenantId ? { id: r.tenantId, name: names.get(r.tenantId) ?? '' } : null,
        actorId: r.actorId,
        actorEmail: r.actorEmail,
        targetType: r.targetType,
        targetId: r.targetId,
        payload: r.payload === null ? null : maskSensitive(r.payload),
        ip: r.ip,
        traceId: r.traceId,
      })),
      nextCursor: rows.length > query.limit ? (page[page.length - 1]?.id.toString() ?? null) : null,
    };
  }
}
