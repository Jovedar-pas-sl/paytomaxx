import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import {
  canChargeSection,
  initialOfferedSection,
  isSectionCode,
  packComponentsOf,
  packProblem,
  sectionsOf,
  type CreateServiceItemDto,
  type PackComponent,
  type ServiceItem,
  type UpdateServiceItemDto,
  type VenueSection,
} from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { chargeRightsFor } from '../venues/charge-rights';

const SELECT = {
  id: true,
  name: true,
  durationMin: true,
  priceCents: true,
  category: true,
  active: true,
  sortOrder: true,
  components: true,
} as const;

const ORDER = [{ sortOrder: 'asc' as const }, { priceCents: 'asc' as const }];

/** La fila tal como la ven las apps (el pack, ya validado; uno raro → sin pack). */
function view<T extends { components: unknown }>(row: T): ServiceItem {
  return { ...(row as unknown as ServiceItem), components: packComponentsOf(row.components) };
}

/**
 * Carta del local (Fase 1A; el mapa del dinero, 20261023100000). Vale para
 * todas las secciones encendidas (copas, habitaciones, comida, entradas,
 * servicios) y un servicio puede ser un pack que se reparte solo entre
 * secciones. Las consultas van por el middleware de tenant (ServiceItem es
 * tenant-scoped): cada local ve y edita solo su carta.
 */
@Injectable()
export class CartaService {
  private readonly prisma: PrismaService;
  private readonly audit: AuditService;

  constructor(@Inject(PrismaService) prisma: PrismaService, @Inject(AuditService) audit: AuditService) {
    this.prisma = prisma;
    this.audit = audit;
  }

  /**
   * Lo que puede cobrar ahora quien llama: lo activo de las secciones
   * encendidas que su puesto puede cobrar (un pack, por su sección).
   */
  async listForStaff(tenantId: string, role: string, userId?: string): Promise<ServiceItem[]> {
    const [rows, sections, rights] = await Promise.all([
      this.prisma.serviceItem.findMany({ where: { tenantId, active: true }, orderBy: ORDER, select: SELECT }),
      this.venueSections(tenantId),
      userId ? this.prisma.asSystem((tx) => chargeRightsFor(tx, tenantId, { userId, role })) : Promise.resolve(null),
    ]);
    const off = new Set<string>(sections.filter((s) => !s.enabled).map((s) => s.code));
    // Un servicio antiguo en «Otros» se cobra en la sección del puesto.
    const fallback = rights ? initialOfferedSection(sections, rights) : null;
    return rows
      .filter((r) => !off.has(r.category))
      .filter((r) => !rights || canChargeSection(rights, isSectionCode(r.category) ? r.category : (fallback ?? r.category)))
      .map(view);
  }

  /** Carta completa (también desactivados) para el panel. */
  async listAll(tenantId: string): Promise<ServiceItem[]> {
    const rows = await this.prisma.serviceItem.findMany({
      where: { tenantId },
      orderBy: ORDER,
      select: SELECT,
    });
    return rows.map(view);
  }

  async create(tenantId: string, actorId: string, dto: CreateServiceItemDto): Promise<ServiceItem> {
    // El pack se comprueba siempre aquí (también si llega sin pasar por el esquema).
    const problem = packProblem(dto.priceCents, dto.category, dto.components);
    if (problem) throw new BadRequestException(problem);
    await this.assertSections(tenantId, dto.category, dto.components ?? null);
    const row = await this.prisma.serviceItem.create({
      data: {
        tenantId,
        name: dto.name,
        durationMin: dto.durationMin ?? null,
        priceCents: dto.priceCents,
        category: dto.category,
        sortOrder: dto.sortOrder ?? 0,
        ...(dto.components ? { components: dto.components } : {}),
      },
      select: SELECT,
    });
    await this.audit.log({
      action: 'carta.item.created',
      tenantId,
      actorId,
      targetType: 'ServiceItem',
      targetId: row.id,
      payload: { name: row.name, priceCents: row.priceCents, category: row.category, components: dto.components ?? null },
    });
    return view(row);
  }

  async update(
    tenantId: string,
    actorId: string,
    id: string,
    dto: UpdateServiceItemDto,
  ): Promise<ServiceItem> {
    const existing = await this.prisma.serviceItem.findFirst({
      where: { id, tenantId },
      select: SELECT,
    });
    if (!existing) throw new NotFoundException('Ese servicio no está en la carta de este local');
    // El pack se comprueba con lo que queda (precio, sección y partes nuevos o los de antes).
    const price = dto.priceCents ?? existing.priceCents;
    const category = dto.category ?? existing.category;
    const components = dto.components === undefined ? packComponentsOf(existing.components) : dto.components;
    const problem = packProblem(price, category, components);
    if (problem) throw new BadRequestException(problem);
    if (dto.category !== undefined || dto.components) await this.assertSections(tenantId, category, components);
    const row = await this.prisma.serviceItem.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.durationMin !== undefined ? { durationMin: dto.durationMin } : {}),
        ...(dto.priceCents !== undefined ? { priceCents: dto.priceCents } : {}),
        ...(dto.category !== undefined ? { category: dto.category } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
        // null = quitar el pack (la columna a NULL).
        ...(dto.components !== undefined ? { components: dto.components ?? Prisma.DbNull } : {}),
      },
      select: SELECT,
    });
    await this.audit.log({
      action: 'carta.item.updated',
      tenantId,
      actorId,
      targetType: 'ServiceItem',
      targetId: id,
      payload: { before: existing, after: row },
    });
    return view(row);
  }

  /** La sección del servicio (y la de cada parte del pack) tiene que estar encendida en el local. */
  private async assertSections(
    tenantId: string,
    category: string,
    components: readonly PackComponent[] | null,
  ): Promise<void> {
    const sections = await this.venueSections(tenantId);
    const byCode = new Map<string, VenueSection>(sections.map((s) => [s.code, s]));
    for (const code of [category, ...(components ?? []).map((c) => c.category)]) {
      const section = byCode.get(code);
      if (!section) throw new BadRequestException('Elige una de las secciones del local');
      if (!section.enabled) {
        throw new BadRequestException(`La sección «${section.label}» está apagada en este local (Ajustes → Secciones).`);
      }
    }
  }

  private async venueSections(tenantId: string): Promise<VenueSection[]> {
    // Venue no va por local en el middleware: id explícito.
    const venue = await this.prisma.venue.findUnique({ where: { id: tenantId }, select: { sections: true } });
    return sectionsOf(venue?.sections);
  }
}
