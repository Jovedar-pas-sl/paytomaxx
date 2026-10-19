import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type {
  BulkCreateTerminalsDto,
  CreateTerminalDto,
  TerminalView,
  UpdateTerminalDto,
  ZoneView,
} from '@nightpay/contracts';

/**
 * Canonicalize a zone value:
 *  - 'BARRA' → 'BARRA'
 *  - 'OTRO' + zoneCustom='vip room' → 'OTRO/VIP ROOM' (trim + upper)
 *  - null → null
 */
export function canonicalizeZone(
  zone: string | undefined | null,
  zoneCustom?: string | null,
): string | null {
  if (!zone) return null;
  if (zone === 'OTRO') {
    if (!zoneCustom) return null;
    return `OTRO/${zoneCustom.trim().toUpperCase()}`;
  }
  return zone;
}

/** Convert canonical zone to display-friendly text for UI. */
export function zoneToDisplay(zone: string | null): string | null {
  if (!zone) return null;
  if (zone.startsWith('OTRO/')) {
    const custom = zone.slice('OTRO/'.length);
    return `${custom.charAt(0).toUpperCase()}${custom.slice(1).toLowerCase()}`;
  }
  return `${zone.charAt(0).toUpperCase()}${zone.slice(1).toLowerCase()}`;
}

function toView(t: {
  id: string;
  externalId: string;
  label: string;
  zone: string | null;
  hardwareModel: string | null;
  deviceSerial: string | null;
  active: boolean;
  deviceTokenHash?: string | null;
  deviceLastSeenAt?: Date | null;
}): TerminalView {
  return {
    id: t.id,
    externalId: t.externalId,
    label: t.label,
    zone: t.zone,
    zoneDisplay: zoneToDisplay(t.zone),
    hardwareModel: t.hardwareModel,
    deviceSerial: t.deviceSerial,
    active: t.active,
    // La credencial nunca sale: solo si hay una.
    devicePaired: Boolean(t.deviceTokenHash),
    deviceLastSeenAt: t.deviceLastSeenAt?.toISOString() ?? null,
  };
}

@Injectable()
export class TerminalsService {
  private readonly prisma: PrismaService;
  private readonly audit: AuditService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(AuditService) audit: AuditService,
  ) {
    this.prisma = prisma;
    this.audit = audit;
  }

  /** Lista terminales del venue (admin). */
  async list(tenantId: string): Promise<TerminalView[]> {
    const rows = await this.prisma.terminal.findMany({
      where: { tenantId },
      orderBy: [{ zone: 'asc' }, { externalId: 'asc' }],
    });
    return rows.map((r) =>
      toView(r as never),
    );
  }

  /**
   * Resumen por zona — agrupa los terminales del venue por su columna `zone`.
   * Solo expone zonas que tienen al menos un terminal. La UI usa esto para
   * llenar el dropdown del operator app.
   */
  async listZones(tenantId: string): Promise<ZoneView[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{ zone: string | null; total: bigint; activeCount: bigint }>
    >`
      SELECT zone,
             COUNT(*)::bigint AS total,
             SUM(CASE WHEN active THEN 1 ELSE 0 END)::bigint AS "activeCount"
        FROM terminals
       WHERE "tenantId" = ${tenantId}::uuid
         AND zone IS NOT NULL
       GROUP BY zone
       ORDER BY zone ASC
    `;
    return rows.map((r) => ({
      zone: r.zone!,
      zoneDisplay: zoneToDisplay(r.zone)!,
      terminalCount: Number(r.total),
      activeCount: Number(r.activeCount),
    }));
  }

  async create(
    tenantId: string,
    actorUserId: string,
    dto: CreateTerminalDto,
  ): Promise<TerminalView> {
    const zone = canonicalizeZone(dto.zone, dto.zoneCustom);

    // Validar externalId único en el venue
    const existing = await this.prisma.terminal.findUnique({
      where: { tenantId_externalId: { tenantId, externalId: dto.externalId } },
    });
    if (existing) {
      throw new ConflictException(`Terminal '${dto.externalId}' ya existe en este venue`);
    }

    const created = await this.prisma.terminal.create({
      data: {
        tenantId,
        externalId: dto.externalId,
        label: dto.label,
        active: dto.active,
        zone,
        hardwareModel: dto.hardwareModel ?? null,
        deviceSerial: dto.deviceSerial ?? null,
      },
    });

    await this.audit.log({
      action: 'terminal.created',
      tenantId,
      actorId: actorUserId,
      targetType: 'Terminal',
      targetId: created.id,
      payload: { externalId: dto.externalId, zone },
    });

    return toView(created as never);
  }

  /**
   * Crea N terminales con prefijo + zona común.
   * Ejemplo: count=4, prefix="PAX-BARRA-" → PAX-BARRA-1..4 todos en zona BARRA.
   * Si el prefijo ya tiene una secuencia previa, continua desde el siguiente número.
   */
  async bulkCreate(
    tenantId: string,
    actorUserId: string,
    dto: BulkCreateTerminalsDto,
  ): Promise<TerminalView[]> {
    const zone = canonicalizeZone(dto.zone, dto.zoneCustom);
    if (!zone) {
      throw new BadRequestException('Zone requerida para bulk create');
    }

    // Detectar siguiente número disponible para el prefijo
    const existing = await this.prisma.terminal.findMany({
      where: { tenantId, externalId: { startsWith: dto.prefix } },
      select: { externalId: true },
    });
    const maxSuffix = existing.reduce((max, t) => {
      const rest = t.externalId.slice(dto.prefix.length);
      const n = parseInt(rest, 10);
      return Number.isFinite(n) && n > max ? n : max;
    }, 0);

    const toCreate = Array.from({ length: dto.count }, (_, i) => {
      const num = maxSuffix + i + 1;
      const externalId = `${dto.prefix}${num}`;
      const label = `${dto.prefix.replace(/-$/, '')} ${num}`;
      return {
        tenantId,
        externalId,
        label,
        active: true,
        zone,
        hardwareModel: dto.hardwareModel,
        deviceSerial: null,
      };
    });

    await this.prisma.terminal.createMany({ data: toCreate });

    await this.audit.log({
      action: 'terminal.bulk_created',
      tenantId,
      actorId: actorUserId,
      targetType: 'Terminal',
      targetId: 'bulk',
      payload: { count: dto.count, zone, prefix: dto.prefix },
    });

    // Devolvemos las recién creadas (orden por externalId asc)
    const created = await this.prisma.terminal.findMany({
      where: {
        tenantId,
        externalId: { in: toCreate.map((t) => t.externalId) },
      },
      orderBy: { externalId: 'asc' },
    });
    return created.map((c) => toView(c as never));
  }

  async update(
    tenantId: string,
    terminalId: string,
    actorUserId: string,
    dto: UpdateTerminalDto,
  ): Promise<TerminalView> {
    const existing = await this.prisma.terminal.findFirst({
      where: { id: terminalId, tenantId },
    });
    if (!existing) throw new NotFoundException('Terminal no encontrado');

    const data: Record<string, unknown> = {};
    if (dto.label !== undefined) data.label = dto.label;
    if (dto.active !== undefined) data.active = dto.active;
    if (dto.hardwareModel !== undefined) data.hardwareModel = dto.hardwareModel;
    if (dto.deviceSerial !== undefined) data.deviceSerial = dto.deviceSerial;
    if (dto.zone !== undefined) {
      data.zone = dto.zone === null ? null : canonicalizeZone(dto.zone, dto.zoneCustom ?? null);
      // OTRO sin nombre daba null: el datáfono se quedaba sin zona sin que nadie lo pidiera.
      if (dto.zone !== null && data.zone === null) {
        throw new BadRequestException('Con la zona OTRO hay que poner su nombre');
      }
    }

    const updated = await this.prisma.terminal.update({
      where: { id: terminalId },
      data,
    });

    await this.audit.log({
      action: 'terminal.updated',
      tenantId,
      actorId: actorUserId,
      targetType: 'Terminal',
      targetId: terminalId,
      payload: { changes: dto },
    });

    return toView(updated as never);
  }
}
