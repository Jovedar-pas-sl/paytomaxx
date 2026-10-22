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
  sameAsSeen,
  sectionsOf,
  type TemplateChange,
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

type TemplateRow = Prisma.ServiceItemGetPayload<{ select: typeof SELECT }>;

/**
 * Los productos marcados para ponerlos como la referencia, comprobados antes
 * de escribir: uno que ya está igual no se toca; uno que cambió desde que el
 * dueño lo miró, que ya no está o que ya no se puede actualizar → 409.
 */
function ticked(plan: TemplateChange<TemplateRow>[], update: NonNullable<ApplyCartaTemplateDto['update']>): TemplateChange<TemplateRow>[] {
  const out: TemplateChange<TemplateRow>[] = [];
  for (const { id, seen } of update) {
    const change = plan.find((c) => c.existing?.id === id);
    if (change?.action === 'keep') continue;
    if (change?.action !== 'update' || !change.existing) {
      throw new ConflictException('Un producto marcado ya no se puede actualizar con la referencia. Vuelve a cargar la carta y revisa los cambios.');
    }
    if (!sameAsSeen(change.existing, seen)) {
      throw new ConflictException(`«${change.existing.name.trim()}» ha cambiado mientras lo revisabas. Vuelve a cargar la carta y revisa los cambios.`);
    }
    out.push(change);
  }
  return out;
}

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

  /**
   * La carta de referencia, en una transacción con el local bloqueado: se
   * vuelve a leer la carta y se comprueba todo antes de escribir nada. Solo se
   * añade lo que falta; un producto existente cambia solo si el dueño lo marcó
   * y sigue como lo vio (si no, 409 y no se escribe nada).
   */
  async applyTemplate(tenantId: string, actorId: string, dto: ApplyCartaTemplateDto): Promise<ApplyCartaTemplateResult> {
    if (dto?.confirm !== true) throw new BadRequestException('Confirma que quieres aplicar los productos y precios.');
    const { summary, updatedIds } = await this.withCartaLock(tenantId, async (tx) => {
      const venue = await tx.venue.findUnique({ where: { id: tenantId }, select: { sections: true } });
      const rows = await tx.serviceItem.findMany({ where: { tenantId }, select: SELECT });
      const plan = cartaTemplatePlan(rows, { sections: sectionsOf(venue?.sections) });
      const toUpdate = ticked(plan, dto.update ?? []);
      for (const change of plan) {
        if (change.action !== 'create') continue;
        const { name, durationMin, priceCents, category, sortOrder, isInvitation } = change.input;
        await tx.serviceItem.create({ data: { tenantId, name, durationMin, priceCents, category, sortOrder, isInvitation: isInvitation ?? false } });
      }
      for (const change of toUpdate) {
        const { durationMin, priceCents, sortOrder } = change.input;
        // Nunca el nombre, la sección ni si es invitación: solo lo que se marcó.
        await tx.serviceItem.update({ where: { id: change.existing!.id }, data: { durationMin, priceCents, sortOrder, active: true } });
      }
      const existing = plan.filter((c) => c.action === 'keep' || c.action === 'update').length;
      return {
        summary: {
          created: plan.filter((c) => c.action === 'create').length,
          updated: toUpdate.length,
          kept: existing - toUpdate.length,
          skipped: plan.filter((c) => c.action === 'skip').length,
        },
        updatedIds: toUpdate.map((c) => c.existing!.id),
      };
    });
    await this.audit.log({
      action: 'carta.template.applied',
      tenantId,
      actorId,
      targetType: 'Venue',
      targetId: tenantId,
      payload: { ...summary, updatedIds },
    });
    return summary;
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
      // NO KEY UPDATE: serializes the carta writers without blocking the payments
      // (their foreign keys only take KEY SHARE on the venue row).
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM venues WHERE id = ${tenantId}::uuid FOR NO KEY UPDATE`;
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
