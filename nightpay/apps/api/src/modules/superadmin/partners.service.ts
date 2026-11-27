import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Partner, Prisma } from '@nightpay/db';
import {
  PARTNER_STEP_UP_FIELDS,
  partnerTransferProblem,
  type CreatePartnerDto,
  type PartnerApiStateDto,
  type PartnerPauseDto,
  type PartnerResumeDto,
  type PartnerStepUpReasonDto,
  type PartnerView,
  type SuperAdminPartnerConnectionView,
  type SuperAdminPartnersOverview,
  type UpdatePartnerDto,
} from '@nightpay/contracts';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { AuditService } from '../audit/audit.service';
import { FREEZE_CACHE_KEY, FREEZE_CACHE_S } from '../partner/auth/partner-freeze';
import { entryWiderThanAddress, ipEntryProblem, normalizeIpEntry } from '../partner/auth/partner-ip';
import { partnerReady, sortScopes, toConnectionAdminView } from '../partner/connections/partner-rules';
import { PARTNER_AUDIT, partnerAuditPayload } from '../partner/partner-audit';
import { partnerApiEnabled, partnerApiMode } from '../partner/partner-flag';
import { changedFields } from './masking';
import { SuperAdminStepUpService } from './step-up.service';
import { SuperAdminAuditService } from './superadmin-audit.service';
import type { SuperAdminActor } from './superadmin.guard';

const PARTNER_NOT_FOUND = 'Socio no encontrado';
const CONNECTION_NOT_FOUND = 'Conexión no encontrada';
const RANGE_NEEDS_REASON = 'Un rango de más de una dirección necesita el motivo.';
const CONNECTION_INCLUDE = { partner: { select: { name: true } }, venue: { select: { name: true } } } as const;
type Tx = TransactionalClient;

const iso = (d: Date | null) => d?.toISOString() ?? null;

export function toPartnerView(p: Partner): PartnerView {
  return {
    id: p.id,
    name: p.name,
    legalName: p.legalName,
    taxId: p.taxId,
    contactEmail: p.contactEmail,
    status: p.status,
    allowedScopes: sortScopes(p.allowedScopes),
    collectionModel: 'VENUE_COLLECTS',
    channel: p.channel === 'ONLINE' ? 'online' : 'in_venue',
    egressIps: [...p.egressIps],
    egressRangeReason: p.egressRangeReason,
    kybCheckedAt: iso(p.kybCheckedAt),
    kybNotes: p.kybNotes,
    dataRole: p.dataRole,
    dpaSignedAt: iso(p.dpaSignedAt),
    dpaVersion: p.dpaVersion,
    dataCountry: p.dataCountry,
    transferMechanism: p.transferMechanism,
    notes: p.notes,
    ready: partnerReady(p),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

/** Lo que se guarda de los campos del socio (el modelo de cobro, fijo: VENUE_COLLECTS hasta el PR 9). */
function partnerData(dto: Partial<CreatePartnerDto>): Prisma.PartnerUncheckedUpdateInput {
  const { totpCode: _code, ...fields } = dto;
  return {
    ...fields,
    ...(fields.allowedScopes ? { allowedScopes: sortScopes(fields.allowedScopes) } : {}),
    ...(fields.egressIps ? { egressIps: [...new Set(fields.egressIps.map(normalizeIpEntry))] } : {}),
    ...(fields.channel ? { channel: fields.channel === 'online' ? 'ONLINE' : 'IN_VENUE' } : {}),
  } as Prisma.PartnerUncheckedUpdateInput;
}

/** IP declaradas: públicas, como mucho un /24 o un /48, y los rangos con motivo; fuera del EEE, el mecanismo. */
function assertPartnerRules(egressIps: readonly string[], rangeReason: string | null | undefined, country: string | null | undefined, mechanism: string | null | undefined): void {
  for (const entry of egressIps) {
    const problem = ipEntryProblem(entry, 'partner');
    if (problem) throw new BadRequestException(problem);
  }
  if (egressIps.some(entryWiderThanAddress) && !rangeReason?.trim()) throw new BadRequestException(RANGE_NEEDS_REASON);
  const transfer = partnerTransferProblem(country, mechanism);
  if (transfer) throw new BadRequestException(transfer);
}

/**
 * Consola del super-admin → «Socios»: el registro de socios (techo de
 * permisos, canal, IP declaradas, KYB y contrato de datos), las conexiones de
 * todos los locales (solo la pista de la clave), la congelación de la API y el
 * interruptor. Funciona también con la API apagada. Piden 2FA: alta,
 * reanudar, suspender, congelar, anular una conexión y editar permisos, IP,
 * KYB o el contrato de datos; con motivo: suspender, congelar, anular y pausar.
 */
@Injectable()
export class SuperAdminPartnersService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SuperAdminStepUpService) private readonly stepUp: SuperAdminStepUpService,
    @Inject(SuperAdminAuditService) private readonly saAudit: SuperAdminAuditService,
  ) {}

  async overview(): Promise<SuperAdminPartnersOverview> {
    const now = new Date();
    const { partners, connections, state } = await this.prisma.acrossVenues(async (tx) => ({
      partners: await tx.partner.findMany({ orderBy: { name: 'asc' }, take: 500 }),
      connections: await tx.partnerConnection.findMany({ include: CONNECTION_INCLUDE, orderBy: { createdAt: 'desc' }, take: 1000 }),
      state: await tx.partnerApiState.findUnique({ where: { id: 1 } }),
    }));
    return {
      partners: partners.map(toPartnerView),
      connections: connections.map(
        (c): SuperAdminPartnerConnectionView => ({ ...toConnectionAdminView(c, [], now), tenantId: c.tenantId, venueName: c.venue.name }),
      ),
      api: {
        enabled: partnerApiEnabled(),
        mode: partnerApiMode(),
        freeze: (state?.freeze as 'none' | 'money' | 'all' | undefined) ?? 'none',
        reason: state?.reason ?? null,
        updatedAt: (state?.updatedAt ?? now).toISOString(),
      },
    };
  }

  async create(actor: SuperAdminActor, dto: CreatePartnerDto): Promise<PartnerView> {
    await this.stepUp.verify(actor, dto.totpCode, 'partner.create');
    assertPartnerRules(dto.egressIps, dto.egressRangeReason, dto.dataCountry, dto.transferMechanism);
    return this.prisma.acrossVenues(async (tx) => {
      const created = await tx.partner.create({
        data: { ...(partnerData(dto) as Prisma.PartnerUncheckedCreateInput), createdById: actor.id },
      });
      await this.saAudit.writeInTx(tx, actor, { action: 'partner.created', targetType: 'Partner', targetId: created.id, after: toPartnerView(created) });
      return toPartnerView(created);
    });
  }

  async update(actor: SuperAdminActor, id: string, dto: UpdatePartnerDto): Promise<PartnerView> {
    if (PARTNER_STEP_UP_FIELDS.some((f) => dto[f] !== undefined)) await this.stepUp.verify(actor, dto.totpCode, 'partner.update');
    const { reason, ...fields } = dto;
    return this.prisma.acrossVenues(async (tx) => {
      const before = await tx.partner.findUnique({ where: { id } });
      if (!before) throw new NotFoundException(PARTNER_NOT_FOUND);
      assertPartnerRules(
        fields.egressIps ?? before.egressIps,
        fields.egressRangeReason === undefined ? before.egressRangeReason : fields.egressRangeReason,
        fields.dataCountry === undefined ? before.dataCountry : fields.dataCountry,
        fields.transferMechanism === undefined ? before.transferMechanism : fields.transferMechanism,
      );
      const updated = await tx.partner.update({ where: { id }, data: partnerData(fields) });
      const diff = changedFields(toPartnerView(before) as unknown as Record<string, unknown>, toPartnerView(updated) as unknown as Record<string, unknown>);
      await this.saAudit.writeInTx(tx, actor, { action: 'partner.updated', targetType: 'Partner', targetId: id, ...diff, reason: reason ?? null });
      return toPartnerView(updated);
    });
  }

  async suspend(actor: SuperAdminActor, id: string, dto: PartnerStepUpReasonDto): Promise<PartnerView> {
    await this.stepUp.verify(actor, dto.totpCode, 'partner.suspend');
    return this.setPartnerStatus(actor, id, 'SUSPENDED', dto.reason);
  }

  async resume(actor: SuperAdminActor, id: string, dto: PartnerResumeDto): Promise<PartnerView> {
    await this.stepUp.verify(actor, dto.totpCode, 'partner.resume');
    return this.setPartnerStatus(actor, id, 'ACTIVE', dto.reason ?? null);
  }

  async pauseConnection(actor: SuperAdminActor, id: string, dto: PartnerPauseDto): Promise<SuperAdminPartnerConnectionView> {
    return this.changeConnection(actor, id, dto.reason, async (tx, conn) => {
      if (conn.status === 'REVOKED') throw new ConflictException('Está anulada');
      const row = await tx.partnerConnection.update({
        where: { id: conn.id, tenantId: conn.tenantId },
        data: { status: 'PAUSED', pausedReason: 'oxiopay' },
        include: CONNECTION_INCLUDE,
      });
      return { row, action: PARTNER_AUDIT.connectionPaused };
    });
  }

  async resumeConnection(actor: SuperAdminActor, id: string, dto: PartnerResumeDto): Promise<SuperAdminPartnerConnectionView> {
    await this.stepUp.verify(actor, dto.totpCode, 'partner.connection.resume');
    return this.changeConnection(actor, id, dto.reason ?? null, async (tx, conn) => {
      if (conn.status === 'REVOKED') throw new ConflictException('Está anulada');
      const row = await tx.partnerConnection.update({
        where: { id: conn.id, tenantId: conn.tenantId },
        data: { status: 'ACTIVE', pausedScopes: [], pausedReason: null, keySuspendedAt: null, keyResumedAt: new Date() },
        include: CONNECTION_INCLUDE,
      });
      return { row, action: PARTNER_AUDIT.connectionResumed };
    });
  }

  async revokeConnection(actor: SuperAdminActor, id: string, dto: PartnerStepUpReasonDto): Promise<SuperAdminPartnerConnectionView> {
    await this.stepUp.verify(actor, dto.totpCode, 'partner.connection.revoke');
    return this.changeConnection(actor, id, dto.reason, async (tx, conn) => {
      const row = await tx.partnerConnection.update({
        where: { id: conn.id, tenantId: conn.tenantId },
        data: { status: 'REVOKED', keyClaimHash: null, keyClaimSealed: null, keyClaimExpiresAt: null },
        include: CONNECTION_INCLUDE,
      });
      return { row, action: PARTNER_AUDIT.keyRevoked };
    });
  }

  /** Congelar o descongelar: la fila con su registro y, tras confirmar, la copia de Redis (60 s). */
  async setApiState(actor: SuperAdminActor, dto: PartnerApiStateDto): Promise<SuperAdminPartnersOverview['api']> {
    await this.stepUp.verify(actor, dto.totpCode, 'partner.api_state');
    const state = await this.prisma.acrossVenues(async (tx) => {
      const before = await tx.partnerApiState.findUnique({ where: { id: 1 } });
      const after = await tx.partnerApiState.upsert({
        where: { id: 1 },
        create: { id: 1, freeze: dto.freeze, reason: dto.reason, updatedById: actor.id },
        update: { freeze: dto.freeze, reason: dto.reason, updatedById: actor.id },
      });
      await this.audit.logInTx(tx, {
        action: dto.freeze === 'none' ? PARTNER_AUDIT.apiUnfrozen : PARTNER_AUDIT.apiFrozen,
        actorId: actor.id,
        actorEmail: actor.email,
        targetType: 'PartnerApiState',
        targetId: '1',
        payload: { freeze: dto.freeze, before: before?.freeze ?? 'none', reason: dto.reason },
      });
      await this.saAudit.writeInTx(tx, actor, {
        action: 'partner.api_state',
        targetType: 'PartnerApiState',
        targetId: '1',
        before: { freeze: before?.freeze ?? 'none' },
        after: { freeze: dto.freeze },
        reason: dto.reason,
      });
      return after;
    });
    try {
      await this.redis.set(FREEZE_CACHE_KEY, dto.freeze, 'EX', FREEZE_CACHE_S);
    } catch {
      throw new ServiceUnavailableException(
        'La congelación quedó guardada, pero Redis no responde: vale en todas las réplicas en 60 segundos como mucho.',
      );
    }
    return { enabled: partnerApiEnabled(), mode: partnerApiMode(), freeze: dto.freeze, reason: state.reason, updatedAt: state.updatedAt.toISOString() };
  }

  private async setPartnerStatus(actor: SuperAdminActor, id: string, status: 'ACTIVE' | 'SUSPENDED', reason: string | null): Promise<PartnerView> {
    return this.prisma.acrossVenues(async (tx) => {
      const before = await tx.partner.findUnique({ where: { id } });
      if (!before) throw new NotFoundException(PARTNER_NOT_FOUND);
      const updated = await tx.partner.update({ where: { id }, data: { status } });
      await this.saAudit.writeInTx(tx, actor, {
        action: status === 'SUSPENDED' ? 'partner.suspended' : 'partner.resumed',
        targetType: 'Partner',
        targetId: id,
        before: { status: before.status },
        after: { status },
        reason,
      });
      return toPartnerView(updated);
    });
  }

  /** Un cambio de una conexión de cualquier local, bloqueada, con su registro del local (y su aviso) y el de la consola. */
  private async changeConnection(
    actor: SuperAdminActor,
    id: string,
    reason: string | null,
    fn: (tx: Tx, conn: { id: string; tenantId: string; status: string }) => Promise<{ row: Prisma.PartnerConnectionGetPayload<{ include: typeof CONNECTION_INCLUDE }>; action: string }>,
  ): Promise<SuperAdminPartnerConnectionView> {
    const now = new Date();
    return this.prisma.acrossVenues(async (tx) => {
      const [conn] = await tx.$queryRaw<Array<{ id: string; tenantId: string; status: string }>>`
        SELECT id, "tenantId", status::text AS status FROM partner_connections WHERE id = ${id}::uuid FOR UPDATE`;
      if (!conn) throw new NotFoundException(CONNECTION_NOT_FOUND);
      const { row, action } = await fn(tx, conn);
      await this.audit.logInTx(tx, {
        action,
        tenantId: row.tenantId,
        actorId: actor.id,
        actorEmail: actor.email,
        targetType: 'PartnerConnection',
        targetId: row.id,
        payload: partnerAuditPayload(row, { by: 'oxiopay' }),
      });
      await this.saAudit.writeInTx(tx, actor, {
        action: action.replace(/^partner\./, 'partner_'),
        tenantId: row.tenantId,
        targetType: 'PartnerConnection',
        targetId: row.id,
        after: { status: row.status, pausedReason: row.pausedReason },
        reason,
      });
      return { ...toConnectionAdminView(row, [], now), tenantId: row.tenantId, venueName: row.venue.name };
    });
  }
}
