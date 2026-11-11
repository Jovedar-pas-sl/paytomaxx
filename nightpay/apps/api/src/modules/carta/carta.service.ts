import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import {
  canChargeSection,
  cartaTemplatePlan,
  initialOfferedSection,
  invitationItemProblem,
  isCartaIcon,
  isSectionCode,
  packComponentsOf,
  packProblem,
  sameAsSeen,
  sectionsOf,
  serviceImagePath,
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
import { checkCartaImage, decodeImageBase64 } from './carta-image';
import { POPULARITY_NIGHTS, readSnapshot, sortByPopularity, unitsByItem, type CartaOrderSnapshot, type SoldLine } from './carta-popularity';

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
  icon: true,
  // Solo la huella: los bytes de la imagen no viajan con la carta.
  image: { select: { contentHash: true } },
} as const;

/** Cobros con tarjeta que cuentan como vendidos. */
const PAID_CARD: ReadonlySet<string> = new Set(['AUTHORIZED', 'PARTIALLY_REFUNDED']);

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
function view<T extends { id: string; components: unknown; icon: string | null; image: { contentHash: string } | null }>(row: T): ServiceItem {
  const { image, ...rest } = row;
  return {
    ...(rest as unknown as ServiceItem),
    components: packComponentsOf(row.components),
    icon: isCartaIcon(row.icon) ? row.icon : null,
    imageUrl: image ? serviceImagePath(row.id, image.contentHash.trim()) : null,
  };
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
      // En una transacción del local: la imagen (FORCE RLS) se lee con el local en la sesión.
      this.prisma.withTenant(tenantId, async (tx) => {
        const items = await tx.serviceItem.findMany({ where: { tenantId, active: true }, orderBy: ORDER, select: SELECT });
        // Los más pedidos arriba: el orden de la noche, calculado una vez y fijo hasta que se cierre.
        const snapshot = await this.nightSnapshot(tx, tenantId, items.map((i) => i.id));
        return snapshot ? sortByPopularity(items, snapshot) : items;
      }),
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

  /**
   * El orden de la noche abierta: si aún no se calculó, se calcula ahora con las
   * unidades vendidas de las últimas 4 noches cerradas y se guarda (solo gana
   * la primera petición: la escritura exige que siga vacío). Sin noche abierta,
   * null: el orden manual de siempre.
   */
  private async nightSnapshot(tx: TransactionalClient, tenantId: string, activeIds: string[]): Promise<CartaOrderSnapshot | null> {
    const night = await tx.venueNight.findFirst({ where: { tenantId, closedAt: null }, orderBy: { openedAt: 'desc' }, select: { id: true, cartaOrder: true } });
    if (!night) return null;
    const saved = readSnapshot(night.cartaOrder);
    if (saved) return saved;
    const closed = await tx.venueNight.findMany({
      where: { tenantId, closedAt: { not: null } },
      orderBy: { openedAt: 'desc' },
      take: POPULARITY_NIGHTS,
      select: { openedAt: true, closedAt: true },
    });
    const ranges = closed.flatMap((n) => (n.closedAt ? [{ createdAt: { gte: n.openedAt, lte: n.closedAt } }] : []));
    const rows = ranges.length
      ? await tx.paymentLine.findMany({
          where: { tenantId, serviceItemId: { in: activeIds }, OR: ranges },
          select: {
            serviceItemId: true,
            qty: true,
            paymentId: true,
            walletChargeId: true,
            payment: { select: { status: true } },
            walletCharge: { select: { status: true, consumptionId: true } },
          },
        })
      : [];
    // Un consumo del saldo anulado después (el dinero volvió al saldo) no se vendió: como un cobro con tarjeta devuelto.
    const consumptionIds = [...new Set(rows.flatMap((r) => (r.walletCharge?.consumptionId ? [r.walletCharge.consumptionId] : [])))];
    const reversed = new Set(
      consumptionIds.length
        ? (await tx.walletConsumption.findMany({ where: { tenantId, id: { in: consumptionIds }, reversedAt: { not: null } }, select: { id: true } })).map((c) => c.id)
        : [],
    );
    const lines: SoldLine[] = rows.map((r) => ({
      serviceItemId: r.serviceItemId,
      qty: r.qty,
      paid: r.payment
        ? PAID_CARD.has(r.payment.status)
        : r.walletCharge?.status === 'ACCEPTED' && !(r.walletCharge.consumptionId !== null && reversed.has(r.walletCharge.consumptionId)),
      // Las partes de un pack (una línea por parte, mismo cobro y producto) cuentan una vez.
      chargeId: r.paymentId ?? r.walletChargeId ?? null,
    }));
    const fresh: CartaOrderSnapshot = { computedAt: new Date().toISOString(), units: unitsByItem(activeIds, lines) };
    // Solo si sigue vacío: dos móviles pidiendo a la vez no se pisan.
    const won = await tx.venueNight.updateMany({ where: { id: night.id, cartaOrder: { equals: Prisma.DbNull } }, data: { cartaOrder: fresh as unknown as Prisma.InputJsonValue } });
    if (won.count > 0) return fresh;
    const again = await tx.venueNight.findUnique({ where: { id: night.id }, select: { cartaOrder: true } });
    return readSnapshot(again?.cartaOrder) ?? fresh;
  }

  /** Carta completa (también desactivados) para el panel. */
  async listAll(tenantId: string): Promise<ServiceItem[]> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.serviceItem.findMany({ where: { tenantId }, orderBy: ORDER, select: SELECT }),
    );
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
          ...(dto.icon ? { icon: dto.icon } : {}),
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
          ...(dto.icon !== undefined ? { icon: dto.icon } : {}),
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

  /**
   * Guarda (o cambia) el logo o la foto del producto: WebP ya comprobado
   * (carta-image.ts). Bajo el mismo candado de la carta. El producto tiene que
   * ser de este local; la clave ajena (producto, local) lo asegura también en
   * la base.
   */
  async setImage(tenantId: string, actorId: string, id: string, base64: string): Promise<ServiceItem> {
    const checked = checkCartaImage(decodeImageBase64(base64));
    if (!checked.ok) throw new BadRequestException(checked.message);
    const { data, contentType, contentHash, width, height } = checked.image;
    const row = await this.withCartaLock(tenantId, async (tx) => {
      const existing = await tx.serviceItem.findFirst({ where: { id, tenantId }, select: { id: true } });
      if (!existing) throw new NotFoundException('Ese servicio no está en la carta de este local');
      await tx.serviceItemImage.upsert({
        where: { serviceItemId: id },
        create: { serviceItemId: id, tenantId, contentType, data, contentHash, width, height },
        update: { contentType, data, contentHash, width, height },
      });
      return tx.serviceItem.findFirstOrThrow({ where: { id, tenantId }, select: SELECT });
    });
    await this.audit.log({
      action: 'carta.item.image_set',
      tenantId,
      actorId,
      targetType: 'ServiceItem',
      targetId: id,
      payload: { contentHash, contentType, bytes: data.length, width, height },
    });
    return view(row);
  }

  /** Quita el logo o la foto (el producto vuelve a su icono). Sin imagen no hace nada. */
  async removeImage(tenantId: string, actorId: string, id: string): Promise<ServiceItem> {
    const { row, removed } = await this.withCartaLock(tenantId, async (tx) => {
      const existing = await tx.serviceItem.findFirst({ where: { id, tenantId }, select: { id: true } });
      if (!existing) throw new NotFoundException('Ese servicio no está en la carta de este local');
      const { count } = await tx.serviceItemImage.deleteMany({ where: { serviceItemId: id, tenantId } });
      return { removed: count, row: await tx.serviceItem.findFirstOrThrow({ where: { id, tenantId }, select: SELECT }) };
    });
    if (removed > 0) {
      await this.audit.log({ action: 'carta.item.image_removed', tenantId, actorId, targetType: 'ServiceItem', targetId: id, payload: {} });
    }
    return view(row);
  }

  /**
   * Los bytes de la imagen para servirla: la dirección lleva el producto y la
   * huella, y las dos tienen que coincidir (una huella vieja o de otro
   * producto → null). Sin sesión (la pide un <img>): el aislamiento es la
   * propia dirección (UUID + SHA-256), no adivinable, y solo sale la imagen.
   */
  async imageFor(id: string, contentHash: string): Promise<{ data: Buffer; contentHash: string; contentType: string } | null> {
    const row = await this.prisma.asSystem((tx) =>
      tx.serviceItemImage.findFirst({
        where: { serviceItemId: id, contentHash },
        select: { data: true, contentHash: true, contentType: true },
      }),
    );
    return row ? { data: Buffer.from(row.data), contentHash: row.contentHash.trim(), contentType: row.contentType } : null;
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
