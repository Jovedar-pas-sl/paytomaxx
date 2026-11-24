import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@nightpay/db';
import {
  maskIban,
  type CreateVenueDto,
  type PauseDto,
  type SetSettlementAccountDto,
  type ResumeDto,
  type StepUpWithReasonDto,
  type UpdateVenueProfileDto,
  type UpdateVenueRulesDto,
  type VenueDetail,
  type VenueListItem,
  type VenueListQuery,
  venueCreateNeedsStepUp,
} from '@nightpay/contracts';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { resolveHoldDays } from '../operators/payout-math';
import { newVenuePaymentMethods } from '../venues/venue-methods';
import { venuePauseScope } from '../venues/venue-pause';
import { changedFields } from './masking';
import { SuperAdminStepUpService } from './step-up.service';
import { SuperAdminAuditService } from './superadmin-audit.service';
import { commissionMapOf, planVenueRulesChange, profileNeedsStepUp } from './superadmin-rules';
import type { SuperAdminActor } from './superadmin.guard';
import { serviceFeeGatewayProblem } from '../payments/service-fee';

const VENUE_NOT_FOUND = 'Local no encontrado';

const venueInclude = { business: { select: { id: true, name: true, status: true } } } as const;
type VenueRow = Prisma.VenueGetPayload<{ include: typeof venueInclude }>;

/**
 * Locales vistos desde la consola: todos, con su negocio y su pausa. Perfil,
 * reglas (comisiones, tope de la chica, días de espera, reglas de
 * aprobación), IBAN de liquidación y pausa. Las reglas, el IBAN y la pausa
 * piden 2FA; el perfil, solo si toca el grupo del saldo o el IVA; el alta,
 * solo con grupo del saldo o comisión propia.
 */
@Injectable()
export class SuperAdminVenuesService {
  private readonly prisma: PrismaService;
  private readonly stepUp: SuperAdminStepUpService;
  private readonly audit: SuperAdminAuditService;
  private readonly config: ConfigService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(SuperAdminStepUpService) stepUp: SuperAdminStepUpService,
    @Inject(SuperAdminAuditService) audit: SuperAdminAuditService,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.prisma = prisma;
    this.stepUp = stepUp;
    this.audit = audit;
    this.config = config;
  }

  async list(query: VenueListQuery): Promise<VenueListItem[]> {
    const q = query.q?.trim();
    const pausedFilter: Prisma.VenueWhereInput =
      query.paused === 'true'
        ? { OR: [{ pausedAt: { not: null } }, { business: { status: 'PAUSED' } }] }
        : query.paused === 'false'
          ? { pausedAt: null, OR: [{ businessId: null }, { business: { status: 'ACTIVE' } }] }
          : {};
    const where: Prisma.VenueWhereInput = {
      deletedAt: null,
      ...(query.businessId ? { businessId: query.businessId } : {}),
      AND: [
        pausedFilter,
        q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { slug: { contains: q.toLowerCase() } }] } : {},
      ],
    };
    const rows = await this.prisma.acrossVenues((tx) =>
      tx.venue.findMany({ where, include: venueInclude, orderBy: { name: 'asc' }, take: 500 }),
    );
    return rows.map(toListItem);
  }

  async get(id: string): Promise<VenueDetail> {
    const venue = await this.load(id);
    const counts = await this.prisma.acrossVenues(async (tx) => ({
      users: await tx.user.count({ where: { tenantId: id, deletedAt: null } }),
      operators: await tx.user.count({ where: { tenantId: id, deletedAt: null, role: 'OPERATOR' } }),
      terminals: await tx.terminal.count({ where: { tenantId: id, active: true } }),
    }));
    return this.toDetail(venue, counts, await this.serviceFeeBlock(id));
  }

  /** Por qué no se puede encender la «Comisión del servicio» en el local (su pasarela); null: se puede. */
  private async serviceFeeBlock(id: string): Promise<string | null> {
    const credential = await this.prisma.acrossVenues((tx) =>
      tx.gatewayCredential.findFirst({ where: { tenantId: id, active: true }, orderBy: { createdAt: 'asc' }, select: { provider: true } }),
    );
    return serviceFeeGatewayProblem(credential?.provider ?? null, this.config.get<string>('PEANPE_AMOUNT_FORMAT_VERIFIED'));
  }

  /** Alta de un local (como POST /admin/venues, con negocio, grupo del saldo y comisión; con estos dos, 2FA). */
  async create(actor: SuperAdminActor, dto: CreateVenueDto): Promise<VenueDetail> {
    if (venueCreateNeedsStepUp(dto)) await this.stepUp.verify(actor, dto.totpCode, 'venue.create');
    const venue = await this.prisma.acrossVenues(async (tx) => {
      const clash = await tx.venue.findUnique({ where: { slug: dto.slug }, select: { id: true } });
      if (clash) throw new ConflictException(`El slug "${dto.slug}" ya está en uso`);
      const business = dto.businessId
        ? await tx.business.findUnique({
            where: { id: dto.businessId },
            select: { defaultPlatformCommissionBps: true, defaultServiceFeeBps: true, defaultTopUpServiceFeeBps: true },
          })
        : null;
      if (dto.businessId && !business) throw new NotFoundException('Negocio no encontrado');
      const commission = dto.platformCommissionBps ?? business?.defaultPlatformCommissionBps ?? undefined;
      // La «Comisión del servicio» del negocio (sus % por defecto); el interruptor, apagado.
      const serviceFeeBps = business?.defaultServiceFeeBps ?? undefined;
      const topUpServiceFeeBps = business?.defaultTopUpServiceFeeBps ?? undefined;
      const created = await tx.venue.create({
        data: {
          name: dto.name,
          slug: dto.slug,
          timezone: dto.timezone ?? 'Europe/Madrid',
          businessId: dto.businessId ?? null,
          walletGroup: dto.walletGroup ?? null,
          // Local nuevo: datáfono apagado de fábrica (los de antes no cambian).
          paymentMethods: { ...newVenuePaymentMethods() },
          ...(commission !== undefined ? { platformCommissionBps: commission } : {}),
          ...(serviceFeeBps !== undefined ? { serviceFeeBps } : {}),
          ...(topUpServiceFeeBps !== undefined ? { topUpServiceFeeBps } : {}),
        },
        include: venueInclude,
      });
      await assertWalletGroupInBusiness(tx, created);
      return created;
    });
    await this.audit.write(actor, {
      action: 'venue.created',
      tenantId: venue.id,
      targetType: 'Venue',
      targetId: venue.id,
      after: {
        ...profileOf(venue),
        slug: venue.slug,
        businessId: venue.businessId,
        platformCommissionBps: venue.platformCommissionBps,
        serviceFeeEnabled: venue.serviceFeeEnabled,
        serviceFeeBps: venue.serviceFeeBps,
        topUpServiceFeeBps: venue.topUpServiceFeeBps,
      },
    });
    return this.get(venue.id);
  }

  async updateProfile(actor: SuperAdminActor, id: string, dto: UpdateVenueProfileDto): Promise<VenueDetail> {
    if (profileNeedsStepUp(dto)) await this.stepUp.verify(actor, dto.totpCode, 'venue.profile');
    const before = await this.load(id);
    const data: Prisma.VenueUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.timezone !== undefined) data.timezone = dto.timezone;
    if (dto.vatBps !== undefined) data.vatBps = dto.vatBps;
    if (dto.vatRegime !== undefined) data.vatRegime = dto.vatRegime;
    if (dto.walletGroup !== undefined) data.walletGroup = dto.walletGroup;
    const after = await this.prisma.acrossVenues(async (tx) => {
      const row = await tx.venue.update({ where: { id }, data, include: venueInclude });
      if (dto.walletGroup) await assertWalletGroupInBusiness(tx, row);
      return row;
    });
    await this.audit.write(actor, {
      action: 'venue.profile_updated',
      tenantId: id,
      targetType: 'Venue',
      targetId: id,
      ...changedFields(profileOf(before), profileOf(after)),
    });
    return this.get(id);
  }

  /**
   * Reglas del local (2FA). refundApprovalThresholdCents y payoutRequiresApproval
   * las aplica «Por aprobar» (modules/approvals, docs/APROBACIONES.md): el
   * encargado pide devoluciones ≥ umbral y pagos a las chicas, el dueño los
   * aprueba con 2FA y quien pide no aprueba.
   */
  async updateRules(actor: SuperAdminActor, id: string, dto: UpdateVenueRulesDto): Promise<VenueDetail> {
    await this.stepUp.verify(actor, dto.totpCode, 'venue.rules');
    const before = await this.load(id);
    const { totpCode: _code, ...rules } = dto;
    // Encenderla en un local cuya pasarela no puede cobrar sus céntimos: no.
    if (rules.serviceFeeEnabled === true && !before.serviceFeeEnabled) {
      const blocked = await this.serviceFeeBlock(id);
      if (blocked) throw new ConflictException({ message: blocked, code: 'SERVICE_FEE_GATEWAY' });
    }
    const maxOverride = await this.prisma.acrossVenues((tx) =>
      tx.user.aggregate({
        where: { tenantId: id, role: 'OPERATOR', deletedAt: null, commissionBps: { not: null } },
        _max: { commissionBps: true },
      }),
    );
    const plan = planVenueRulesChange(before, rules, maxOverride._max.commissionBps ?? null);
    if (!plan.ok) throw new BadRequestException(plan.problem);
    const after = await this.prisma.acrossVenues((tx) =>
      tx.venue.update({
        where: { id },
        data: plan.change as Prisma.VenueUpdateInput,
        include: venueInclude,
      }),
    );
    await this.audit.write(actor, {
      action: 'venue.rules_updated',
      tenantId: id,
      targetType: 'Venue',
      targetId: id,
      ...changedFields(rulesOf(before), rulesOf(after)),
    });
    return this.get(id);
  }

  /** IBAN donde el banco liquida los cobros con tarjeta (2FA). Ya normalizado y validado mod-97. */
  async setSettlementAccount(actor: SuperAdminActor, id: string, dto: SetSettlementAccountDto): Promise<VenueDetail> {
    await this.stepUp.verify(actor, dto.totpCode, 'venue.settlement_account');
    const before = await this.load(id);
    await this.prisma.acrossVenues((tx) =>
      tx.venue.update({ where: { id }, data: { settlementIban: dto.iban, settlementHolder: dto.holder } }),
    );
    await this.audit.write(actor, {
      action: 'venue.settlement_account_set',
      tenantId: id,
      targetType: 'Venue',
      targetId: id,
      before: { settlementIban: before.settlementIban, settlementHolder: before.settlementHolder },
      after: { settlementIban: dto.iban, settlementHolder: dto.holder },
    });
    return this.get(id);
  }

  async clearSettlementAccount(actor: SuperAdminActor, id: string, dto: StepUpWithReasonDto): Promise<VenueDetail> {
    await this.stepUp.verify(actor, dto.totpCode, 'venue.settlement_account_clear');
    const before = await this.load(id);
    if (!before.settlementIban) throw new ConflictException('Este local no tiene IBAN de liquidación');
    await this.prisma.acrossVenues((tx) =>
      tx.venue.update({ where: { id }, data: { settlementIban: null, settlementHolder: null } }),
    );
    await this.audit.write(actor, {
      action: 'venue.settlement_account_cleared',
      tenantId: id,
      targetType: 'Venue',
      targetId: id,
      before: { settlementIban: before.settlementIban, settlementHolder: before.settlementHolder },
      after: { settlementIban: null, settlementHolder: null },
      reason: dto.reason,
    });
    return this.get(id);
  }

  /** Pausa el local: sin cobros, recargas ni cobros del saldo nuevos (2FA). */
  async pause(actor: SuperAdminActor, id: string, dto: PauseDto): Promise<VenueDetail> {
    await this.stepUp.verify(actor, dto.totpCode, 'venue.pause');
    const before = await this.load(id);
    if (before.pausedAt) throw new ConflictException('Este local ya está en pausa');
    const pausedAt = new Date();
    await this.prisma.acrossVenues((tx) =>
      tx.venue.update({ where: { id }, data: { pausedAt, pausedReason: dto.reason } }),
    );
    await this.audit.write(actor, {
      action: 'venue.paused',
      tenantId: id,
      targetType: 'Venue',
      targetId: id,
      before: { pausedAt: null },
      after: { pausedAt },
      reason: dto.reason,
    });
    return this.get(id);
  }

  async resume(actor: SuperAdminActor, id: string, dto: ResumeDto): Promise<VenueDetail> {
    await this.stepUp.verify(actor, dto.totpCode, 'venue.resume');
    const before = await this.load(id);
    if (!before.pausedAt) throw new ConflictException('Este local no está en pausa');
    await this.prisma.acrossVenues((tx) =>
      tx.venue.update({ where: { id }, data: { pausedAt: null, pausedReason: null } }),
    );
    await this.audit.write(actor, {
      action: 'venue.resumed',
      tenantId: id,
      targetType: 'Venue',
      targetId: id,
      before: { pausedAt: before.pausedAt, pausedReason: before.pausedReason },
      after: { pausedAt: null },
      reason: dto.reason ?? null,
      // El negocio puede seguir en pausa: entonces el local sigue sin cobrar.
      extra: before.business?.status === 'PAUSED' ? { businessStillPaused: true } : undefined,
    });
    return this.get(id);
  }

  private async load(id: string): Promise<VenueRow> {
    const venue = await this.prisma.acrossVenues((tx) =>
      tx.venue.findFirst({ where: { id, deletedAt: null }, include: venueInclude }),
    );
    if (!venue) throw new NotFoundException(VENUE_NOT_FOUND);
    return venue;
  }

  private toDetail(v: VenueRow, counts: VenueDetail['counts'], serviceFeeBlockedReason: string | null = null): VenueDetail {
    return {
      ...toListItem(v),
      vatBps: v.vatBps,
      vatRegime: v.vatRegime,
      settlementIban: v.settlementIban,
      settlementHolder: v.settlementHolder,
      rules: {
        operatorMaxCobroCents: v.operatorMaxCobroCents,
        platformCommissionBps: v.platformCommissionBps,
        operatorCommissionDefaults: commissionMapOf(v.operatorCommissionDefaults),
        payoutHoldDays: v.payoutHoldDays,
        effectivePayoutHoldDays: resolveHoldDays(v.payoutHoldDays, this.config.get('PAYOUT_HOLD_DAYS')),
        refundApprovalThresholdCents: v.refundApprovalThresholdCents,
        payoutRequiresApproval: v.payoutRequiresApproval,
        serviceFeeEnabled: v.serviceFeeEnabled,
        serviceFeeBps: v.serviceFeeBps,
        topUpServiceFeeBps: v.topUpServiceFeeBps,
        serviceFeeBlockedReason,
      },
      counts,
    };
  }
}

export function toListItem(v: VenueRow): VenueListItem {
  const pausedBy = venuePauseScope(v);
  return {
    id: v.id,
    name: v.name,
    slug: v.slug,
    timezone: v.timezone,
    walletGroup: v.walletGroup,
    business: v.business ? { id: v.business.id, name: v.business.name, status: v.business.status } : null,
    paused: pausedBy !== null,
    pausedBy,
    pausedAt: v.pausedAt?.toISOString() ?? null,
    pausedReason: v.pausedReason,
    settlementIbanMasked: maskIban(v.settlementIban),
    createdAt: v.createdAt.toISOString(),
  };
}

/**
 * El grupo del saldo, solo dentro de un negocio: si lo lleva un local de otro
 * negocio, 409 con sus nombres. Sin negocio (este local o el otro) no se compara.
 * Va ya hecho el cambio y en su transacción: si lanza, no se guarda nada.
 */
export async function assertWalletGroupInBusiness(
  tx: TransactionalClient,
  venue: { id: string; walletGroup: string | null; businessId: string | null },
): Promise<void> {
  if (!venue.walletGroup || !venue.businessId) return;
  const others = await tx.venue.findMany({
    where: { walletGroup: venue.walletGroup, id: { not: venue.id }, businessId: { not: null }, NOT: { businessId: venue.businessId } },
    select: { name: true },
    orderBy: { name: 'asc' },
  });
  if (others.length === 0) return;
  throw new ConflictException(
    `El grupo del saldo «${venue.walletGroup}» ya lo usa otro negocio (${others.map((v) => v.name).join(', ')}): ` +
      'el saldo de los clientes pasaría de un negocio a otro. Usa otro grupo.',
  );
}

function profileOf(v: VenueRow): Record<string, unknown> {
  return { name: v.name, timezone: v.timezone, vatBps: v.vatBps, vatRegime: v.vatRegime, walletGroup: v.walletGroup };
}

function rulesOf(v: VenueRow): Record<string, unknown> {
  return {
    operatorMaxCobroCents: v.operatorMaxCobroCents,
    platformCommissionBps: v.platformCommissionBps,
    operatorCommissionDefaults: commissionMapOf(v.operatorCommissionDefaults),
    payoutHoldDays: v.payoutHoldDays,
    refundApprovalThresholdCents: v.refundApprovalThresholdCents,
    payoutRequiresApproval: v.payoutRequiresApproval,
    serviceFeeEnabled: v.serviceFeeEnabled,
    serviceFeeBps: v.serviceFeeBps,
    topUpServiceFeeBps: v.topUpServiceFeeBps,
  };
}
