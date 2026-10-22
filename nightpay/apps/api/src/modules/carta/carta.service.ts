import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import {
  canChargeSection,
  cartaTemplatePlan,
  initialOfferedSection,
  invitationItemProblem,
  isSectionCode,
  packComponentsOf,
  packProblem,
  sectionsOf,
  type CreateServiceItemDto,
  type ApplyCartaTemplateDto,
  type ApplyCartaTemplateResult,
  type PackComponent,
  type ServiceItem,
  type UpdateServiceItemDto,
  type VenueSection,
} from '@nightpay/contracts';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
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
  isInvitation: true,
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

  /** One venue, one transaction: re-read and validate the entire plan before writing. */
  async applyTemplate(tenantId: string, actorId: string, dto: ApplyCartaTemplateDto): Promise<ApplyCartaTemplateResult> {
    if (dto?.confirm !== true) throw new BadRequestException('Confirma que quieres aplicar los productos y precios.');
    const result = await this.withCartaLock(tenantId, async (tx) => {
      const venue = await tx.venue.findUnique({ where: { id: tenantId }, select: { sections: true } });
      const rows = await tx.serviceItem.findMany({ where: { tenantId }, select: SELECT });
      const plan = cartaTemplatePlan(rows);
      const conflicts = plan.filter((change) => change.action === 'conflict');
      if (conflicts.length) {
        throw new ConflictException(`Revisa nombres duplicados, packs o invitaciones: ${conflicts.map((change) => change.input.name).join(', ')}.`);
      }
      const sections = sectionsOf(venue?.sections);
      for (const change of plan) {
        const section = sections.find((s) => s.code === change.input.category);
        if (!section?.enabled) throw new BadRequestException(`La sección «${section?.label ?? change.input.category}» está apagada en este local (Ajustes → Secciones).`);
      }
      const summary: ApplyCartaTemplateResult = { created: 0, updated: 0, kept: 0 };
      for (const change of plan) {
        if (change.action === 'keep') { summary.kept++; continue; }
        const { name, durationMin, priceCents, category, sortOrder, isInvitation } = change.input;
        const data = { name, durationMin, priceCents, category, sortOrder, active: true, isInvitation: isInvitation ?? false };
        if (change.existing) {
          await tx.serviceItem.update({ where: { id: change.existing.id }, data });
          summary.updated++;
        } else {
          await tx.serviceItem.create({ data: { ...data, tenantId } });
          summary.created++;
        }
      }
      return summary;
    });
    await this.audit.log({ action: 'carta.template.applied', tenantId, actorId, targetType: 'Venue', targetId: tenantId, payload: { ...result } });
    return result;
  }

  async create(tenantId: string, actorId: string, dto: CreateServiceItemDto): Promise<ServiceItem> {
    const row = await this.withCartaLock(tenantId, async (tx) => {
      // Validate after taking the same lock used by the template and PATCH.
      const problem =
        packProblem(dto.priceCents, dto.category, dto.components) ??
        invitationItemProblem(dto.isInvitation, dto.category, dto.components);
      if (problem) throw new BadRequestException(problem);
      await this.assertSections(tenantId, dto.category, dto.components ?? null, tx);
      return tx.serviceItem.create({
        data: {
          tenantId,
          name: dto.name,
          durationMin: dto.durationMin ?? null,
          priceCents: dto.priceCents,
          category: dto.category,
          sortOrder: dto.sortOrder ?? 0,
          ...(dto.components ? { components: dto.components } : {}),
          ...(dto.isInvitation ? { isInvitation: true } : {}),
        },
        select: SELECT,
      });
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
    const { existing, row } = await this.withCartaLock(tenantId, async (tx) => {
      const existing = await tx.serviceItem.findFirst({ where: { id, tenantId }, select: SELECT });
      if (!existing) throw new NotFoundException('Ese servicio no está en la carta de este local');
      // Read, validate the resulting pack and write while retaining the venue
      // lock; a template cannot change the price between these operations.
      const price = dto.priceCents ?? existing.priceCents;
      const category = dto.category ?? existing.category;
      const components = dto.components === undefined ? packComponentsOf(existing.components) : dto.components;
      const isInvitation = dto.isInvitation ?? existing.isInvitation;
      const problem = packProblem(price, category, components) ?? invitationItemProblem(isInvitation, category, components);
      if (problem) throw new BadRequestException(problem);
      if (dto.category !== undefined || dto.components) await this.assertSections(tenantId, category, components, tx);
      const row = await tx.serviceItem.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.durationMin !== undefined ? { durationMin: dto.durationMin } : {}),
          ...(dto.priceCents !== undefined ? { priceCents: dto.priceCents } : {}),
          ...(dto.category !== undefined ? { category: dto.category } : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          ...(dto.isInvitation !== undefined ? { isInvitation: dto.isInvitation } : {}),
          ...(dto.components !== undefined ? { components: dto.components ?? Prisma.DbNull } : {}),
        },
        select: SELECT,
      });
      return { existing, row };
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
    tx: TransactionalClient,
  ): Promise<void> {
    const sections = await this.venueSections(tenantId, tx);
    const byCode = new Map<string, VenueSection>(sections.map((s) => [s.code, s]));
    for (const code of [category, ...(components ?? []).map((c) => c.category)]) {
      const section = byCode.get(code);
      if (!section) throw new BadRequestException('Elige una de las secciones del local');
      if (!section.enabled) {
        throw new BadRequestException(`La sección «${section.label}» está apagada en este local (Ajustes → Secciones).`);
      }
    }
  }

  private async withCartaLock<T>(tenantId: string, work: (tx: TransactionalClient) => Promise<T>): Promise<T> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      // Lock even an empty carta, and use one ordering for all its writers.
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM venues WHERE id = ${tenantId}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('No existe este local');
      return work(tx);
    });
  }

  private async venueSections(tenantId: string, client: Pick<TransactionalClient, 'venue'> = this.prisma): Promise<VenueSection[]> {
    // Venue no va por local en el middleware: id explícito.
    const venue = await client.venue.findUnique({ where: { id: tenantId }, select: { sections: true } });
    return sectionsOf(venue?.sections);
  }
}
