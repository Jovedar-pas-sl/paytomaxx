import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateServiceItemDto,
  ServiceItem,
  UpdateServiceItemDto,
} from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

const SELECT = {
  id: true,
  name: true,
  durationMin: true,
  priceCents: true,
  category: true,
  active: true,
  sortOrder: true,
} as const;

const ORDER = [{ sortOrder: 'asc' as const }, { priceCents: 'asc' as const }];

/**
 * Carta de servicios del local (Fase 1A). Las consultas van por el
 * middleware de tenant (ServiceItem es tenant-scoped): cada local ve y
 * edita solo su carta.
 */
@Injectable()
export class CartaService {
  private readonly prisma: PrismaService;
  private readonly audit: AuditService;

  constructor(@Inject(PrismaService) prisma: PrismaService, @Inject(AuditService) audit: AuditService) {
    this.prisma = prisma;
    this.audit = audit;
  }

  /** Lo que se puede cobrar ahora. La chica solo ve sus servicios. */
  async listForStaff(tenantId: string, role: string): Promise<ServiceItem[]> {
    const rows = await this.prisma.serviceItem.findMany({
      where: {
        tenantId,
        active: true,
        ...(role === 'OPERATOR' ? { category: 'CHICA_SERVICE' } : {}),
      },
      orderBy: ORDER,
      select: SELECT,
    });
    return rows as ServiceItem[];
  }

  /** Carta completa (también desactivados) para el panel. */
  async listAll(tenantId: string): Promise<ServiceItem[]> {
    const rows = await this.prisma.serviceItem.findMany({
      where: { tenantId },
      orderBy: ORDER,
      select: SELECT,
    });
    return rows as ServiceItem[];
  }

  async create(tenantId: string, actorId: string, dto: CreateServiceItemDto): Promise<ServiceItem> {
    const row = await this.prisma.serviceItem.create({
      data: {
        tenantId,
        name: dto.name,
        durationMin: dto.durationMin ?? null,
        priceCents: dto.priceCents,
        category: dto.category,
        sortOrder: dto.sortOrder ?? 0,
      },
      select: SELECT,
    });
    await this.audit.log({
      action: 'carta.item.created',
      tenantId,
      actorId,
      targetType: 'ServiceItem',
      targetId: row.id,
      payload: { name: row.name, priceCents: row.priceCents, category: row.category },
    });
    return row as ServiceItem;
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
    const row = await this.prisma.serviceItem.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.durationMin !== undefined ? { durationMin: dto.durationMin } : {}),
        ...(dto.priceCents !== undefined ? { priceCents: dto.priceCents } : {}),
        ...(dto.category !== undefined ? { category: dto.category } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
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
    return row as ServiceItem;
  }
}
