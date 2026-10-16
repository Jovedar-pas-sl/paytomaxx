import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import {
  normalizeTaxId,
  type AssignVenuesDto,
  type BusinessListQuery,
  type BusinessView,
  type CreateBusinessDto,
  type PauseDto,
  type ResumeDto,
  type UpdateBusinessDto,
  type BusinessDetail,
} from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { changedFields } from './masking';
import { SuperAdminStepUpService } from './step-up.service';
import { SuperAdminAuditService } from './superadmin-audit.service';
import type { SuperAdminActor } from './superadmin.guard';
import { SuperAdminVenuesService } from './venues.service';

const BUSINESS_NOT_FOUND = 'Negocio no encontrado';

type BusinessRow = Prisma.BusinessGetPayload<{ include: { _count: { select: { venues: true } } } }>;

/**
 * Negocios clientes de OxioPay (razón social con sus locales). Tabla global:
 * todo con acrossVenues (RLS de businesses solo con bypass). Pausar un negocio
 * para los cobros de todos sus locales (423 VENUE_PAUSED).
 */
@Injectable()
export class SuperAdminBusinessesService {
  private readonly prisma: PrismaService;
  private readonly stepUp: SuperAdminStepUpService;
  private readonly audit: SuperAdminAuditService;
  private readonly venues: SuperAdminVenuesService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(SuperAdminStepUpService) stepUp: SuperAdminStepUpService,
    @Inject(SuperAdminAuditService) audit: SuperAdminAuditService,
    @Inject(SuperAdminVenuesService) venues: SuperAdminVenuesService,
  ) {
    this.prisma = prisma;
    this.stepUp = stepUp;
    this.audit = audit;
    this.venues = venues;
  }

  async list(query: BusinessListQuery): Promise<BusinessView[]> {
    const q = query.q?.trim();
    const where: Prisma.BusinessWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { taxId: { contains: normalizeTaxId(q) } },
              { contactEmail: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.acrossVenues((tx) =>
      tx.business.findMany({ where, include: countVenues, orderBy: { name: 'asc' }, take: 500 }),
    );
    return rows.map(toBusinessView);
  }

  async get(id: string): Promise<BusinessDetail> {
    const business = await this.load(id);
    return { ...toBusinessView(business), venues: await this.venues.list({ businessId: id }) };
  }

  async create(actor: SuperAdminActor, dto: CreateBusinessDto): Promise<BusinessView> {
    const created = await this.prisma
      .acrossVenues((tx) => tx.business.create({ data: { ...businessData(dto), name: dto.name } as Prisma.BusinessCreateInput, include: countVenues }))
      .catch(taxIdClash);
    await this.audit.write(actor, {
      action: 'business.created',
      targetType: 'Business',
      targetId: created.id,
      after: snapshot(created),
    });
    return toBusinessView(created);
  }

  async update(actor: SuperAdminActor, id: string, dto: UpdateBusinessDto): Promise<BusinessView> {
    const before = await this.load(id);
    const updated = await this.prisma
      .acrossVenues((tx) => tx.business.update({ where: { id }, data: businessData(dto), include: countVenues }))
      .catch(taxIdClash);
    const diff = changedFields(snapshot(before), snapshot(updated));
    await this.audit.write(actor, { action: 'business.updated', targetType: 'Business', targetId: id, ...diff });
    return toBusinessView(updated);
  }

  /** Pausa el negocio: ninguno de sus locales acepta cobros nuevos (2FA). */
  async pause(actor: SuperAdminActor, id: string, dto: PauseDto): Promise<BusinessView> {
    await this.stepUp.verify(actor, dto.totpCode, 'business.pause');
    const before = await this.load(id);
    if (before.status === 'PAUSED') throw new ConflictException('Este negocio ya está en pausa');
    const updated = await this.prisma.acrossVenues((tx) =>
      tx.business.update({
        where: { id },
        data: { status: 'PAUSED', pausedAt: new Date(), pausedReason: dto.reason },
        include: countVenues,
      }),
    );
    await this.audit.write(actor, {
      action: 'business.paused',
      targetType: 'Business',
      targetId: id,
      before: { status: before.status },
      after: { status: 'PAUSED', pausedAt: updated.pausedAt },
      reason: dto.reason,
      extra: { venueIds: await this.venueIdsOf(id) },
    });
    return toBusinessView(updated);
  }

  async resume(actor: SuperAdminActor, id: string, dto: ResumeDto): Promise<BusinessView> {
    await this.stepUp.verify(actor, dto.totpCode, 'business.resume');
    const before = await this.load(id);
    if (before.status !== 'PAUSED') throw new ConflictException('Este negocio no está en pausa');
    const updated = await this.prisma.acrossVenues((tx) =>
      tx.business.update({
        where: { id },
        data: { status: 'ACTIVE', pausedAt: null, pausedReason: null },
        include: countVenues,
      }),
    );
    await this.audit.write(actor, {
      action: 'business.resumed',
      targetType: 'Business',
      targetId: id,
      before: { status: before.status, pausedAt: before.pausedAt, pausedReason: before.pausedReason },
      after: { status: 'ACTIVE' },
      reason: dto.reason ?? null,
    });
    return toBusinessView(updated);
  }

  /** Mete locales en el negocio (si estaban en otro, se cambian). */
  async assignVenues(actor: SuperAdminActor, id: string, dto: AssignVenuesDto): Promise<BusinessDetail> {
    await this.load(id);
    const ids = [...new Set(dto.venueIds)];
    const moved = await this.prisma.acrossVenues(async (tx) => {
      const found = await tx.venue.findMany({
        where: { id: { in: ids }, deletedAt: null },
        select: { id: true, businessId: true },
      });
      if (found.length !== ids.length) throw new NotFoundException('Algún local no existe o está borrado');
      await tx.venue.updateMany({ where: { id: { in: ids } }, data: { businessId: id } });
      return found.filter((v) => v.businessId !== id);
    });
    for (const v of moved) {
      await this.audit.write(actor, {
        action: 'venue.business_assigned',
        tenantId: v.id,
        targetType: 'Venue',
        targetId: v.id,
        before: { businessId: v.businessId },
        after: { businessId: id },
      });
    }
    return this.get(id);
  }

  async unassignVenue(actor: SuperAdminActor, id: string, venueId: string): Promise<BusinessDetail> {
    const res = await this.prisma.acrossVenues((tx) =>
      tx.venue.updateMany({ where: { id: venueId, businessId: id }, data: { businessId: null } }),
    );
    if (res.count === 0) throw new NotFoundException('Ese local no es de este negocio');
    await this.audit.write(actor, {
      action: 'venue.business_assigned',
      tenantId: venueId,
      targetType: 'Venue',
      targetId: venueId,
      before: { businessId: id },
      after: { businessId: null },
    });
    return this.get(id);
  }

  private async load(id: string): Promise<BusinessRow> {
    const business = await this.prisma.acrossVenues((tx) => tx.business.findUnique({ where: { id }, include: countVenues }));
    if (!business) throw new NotFoundException(BUSINESS_NOT_FOUND);
    return business;
  }

  private async venueIdsOf(businessId: string): Promise<string[]> {
    const rows = await this.prisma.acrossVenues((tx) =>
      tx.venue.findMany({ where: { businessId, deletedAt: null }, select: { id: true } }),
    );
    return rows.map((r) => r.id);
  }
}

const countVenues = { _count: { select: { venues: { where: { deletedAt: null } } } } } as const;

/** Solo los campos que vienen (undefined = no se toca; null = se borra). */
function businessData(dto: Partial<CreateBusinessDto>): Prisma.BusinessUpdateInput {
  return Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined));
}

function taxIdClash(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    throw new ConflictException('Ya hay un negocio con ese NIF/CIF');
  }
  throw err;
}

function snapshot(b: BusinessRow): Record<string, unknown> {
  return {
    name: b.name,
    taxId: b.taxId,
    contactName: b.contactName,
    contactEmail: b.contactEmail,
    contactPhone: b.contactPhone,
    notes: b.notes,
    status: b.status,
    defaultPlatformCommissionBps: b.defaultPlatformCommissionBps,
  };
}

export function toBusinessView(b: BusinessRow): BusinessView {
  return {
    id: b.id,
    name: b.name,
    taxId: b.taxId,
    contactName: b.contactName,
    contactEmail: b.contactEmail,
    contactPhone: b.contactPhone,
    notes: b.notes,
    status: b.status,
    pausedAt: b.pausedAt?.toISOString() ?? null,
    pausedReason: b.pausedReason,
    defaultPlatformCommissionBps: b.defaultPlatformCommissionBps,
    venueCount: b._count.venues,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  };
}
