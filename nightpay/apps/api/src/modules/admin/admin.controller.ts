import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Tenant } from '../../common/decorators/tenant.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RefreshTokenService } from '../auth/refresh-token.service';
import { AuditService } from '../audit/audit.service';
import { OperatorsService } from '../operators/operators.service';
import { ClsService } from 'nestjs-cls';
import {
  CreateOperatorSchema,
  CreatePayoutSchema,
  UpdateOperatorSchema,
  type CreateOperatorDto,
  type CreatePayoutDto,
  type JwtPayload,
  type PaymentStatus,
  type UpdateOperatorDto,
} from '@nightpay/contracts';
import type { RequestContext } from '../../common/context/request-context';

const VenueSettingsUpdateSchema = z.object({
  operatorMaxCobroCents: z.number().int().min(0).max(10_000_00).optional(),
  platformCommissionBps: z.number().int().min(0).max(10_000).optional(),
  // Comisiones por categoría — admin puede editar el mapa entero o solo
  // algunas claves. Las omitidas mantienen su valor actual.
  operatorCommissionDefaults: z.object({
    CHICA_SERVICE: z.number().int().min(0).max(10_000).optional(),
    VENUE_BAR: z.number().int().min(0).max(10_000).optional(),
    VENUE_ROOM: z.number().int().min(0).max(10_000).optional(),
    VENUE_FOOD: z.number().int().min(0).max(10_000).optional(),
    EXTRA: z.number().int().min(0).max(10_000).optional(),
  }).optional(),
});
type VenueSettingsUpdate = z.infer<typeof VenueSettingsUpdateSchema>;

const ListPaymentsQuerySchema = z.object({
  status: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? (v.split(',').filter(Boolean) as PaymentStatus[])
        : undefined,
    ),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().uuid().optional(),
});
type ListPaymentsQuery = z.infer<typeof ListPaymentsQuerySchema>;

/**
 * Z-report (cierre de caja) — query params from/to en formato ISO date.
 * Default: hoy 00:00 → ahora.
 */
const ZReportQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
type ZReportQuery = z.infer<typeof ZReportQuerySchema>;

/**
 * VAT 303 — desglose IVA trimestral.
 * quarter: "Q1-2026", "Q2-2026", "Q3-2026", "Q4-2026".
 * Si no se pasa, calcula el trimestre actual.
 */
const VatReportQuerySchema = z.object({
  quarter: z
    .string()
    .regex(/^Q[1-4]-\d{4}$/, 'Formato: Q1-2026, Q2-2026, etc.')
    .optional(),
});
type VatReportQuery = z.infer<typeof VatReportQuerySchema>;

export function quarterRange(quarter: string | undefined): { from: Date; to: Date; label: string } {
  const now = new Date();
  let year: number;
  let q: number;
  if (quarter) {
    const m = /^Q([1-4])-(\d{4})$/.exec(quarter);
    if (!m) throw new Error('invalid quarter format');
    q = parseInt(m[1]!, 10);
    year = parseInt(m[2]!, 10);
  } else {
    year = now.getUTCFullYear();
    q = Math.floor(now.getUTCMonth() / 3) + 1;
  }
  const fromMonth = (q - 1) * 3;
  const from = new Date(Date.UTC(year, fromMonth, 1));
  const to = new Date(Date.UTC(year, fromMonth + 3, 1));
  return { from, to, label: `Q${q}-${year}` };
}

@Controller('admin')
@UseGuards(RolesGuard)
export class AdminController {
  private readonly prisma: PrismaService;
  private readonly refreshTokens: RefreshTokenService;
  private readonly audit: AuditService;
  private readonly operators: OperatorsService;
  private readonly cls: ClsService<{ ctx: RequestContext }>;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(RefreshTokenService) refreshTokens: RefreshTokenService,
    @Inject(AuditService) audit: AuditService,
    @Inject(OperatorsService) operators: OperatorsService,
    @Inject(ClsService) cls: ClsService<{ ctx: RequestContext }>,
  ) {
    this.prisma = prisma;
    this.refreshTokens = refreshTokens;
    this.audit = audit;
    this.operators = operators;
    this.cls = cls;
  }

  /**
   * Lista paginada de pagos del venue (cursor-based).
   * Filtros: status (lista comma-separated), limit, cursor (id del ultimo de la pagina anterior).
   */
  @Get('payments')
  @Roles('OWNER', 'MANAGER')
  async listPayments(
    @Tenant() _tenantId: string,
    @Query(new ZodValidationPipe(ListPaymentsQuerySchema)) q: ListPaymentsQuery,
  ) {
    // tenantId lo inyecta el middleware Prisma desde CLS
    const items = await this.prisma.payment.findMany({
      where: q.status ? { status: { in: q.status } } : {},
      orderBy: { createdAt: 'desc' },
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        amountCents: true,
        availableAmountCents: true,
        currency: true,
        status: true,
        provider: true,
        providerTxId: true,
        createdAt: true,
        updatedAt: true,
        terminal: { select: { externalId: true, label: true } },
      },
    });

    const hasMore = items.length > q.limit;
    const page = hasMore ? items.slice(0, q.limit) : items;
    return {
      items: page,
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
    };
  }

  /**
   * Metricas agregadas del venue (hoy + 7 dias).
   * Bruto = sum amountCents AUTHORIZED|PARTIALLY_REFUNDED|REFUNDED
   * Refundeado = sum refunds.amountCents SUCCEEDED
   * Neto = bruto - refundeado
   */
  @Get('metrics')
  @Roles('OWNER', 'MANAGER')
  async metrics() {
    const today = startOfDay(new Date());
    const lastWeek = new Date(today.getTime() - 7 * 24 * 3600 * 1000);

    const [todayAggregate, weekAggregate, todayRefunds, weekRefunds, statusBreakdown] =
      await Promise.all([
        this.prisma.payment.aggregate({
          where: {
            createdAt: { gte: today },
            status: { in: ['AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
          },
          _sum: { amountCents: true },
          _count: { _all: true },
        }),
        this.prisma.payment.aggregate({
          where: {
            createdAt: { gte: lastWeek },
            status: { in: ['AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
          },
          _sum: { amountCents: true },
          _count: { _all: true },
        }),
        this.prisma.refund.aggregate({
          where: { createdAt: { gte: today }, status: 'SUCCEEDED' },
          _sum: { amountCents: true },
        }),
        this.prisma.refund.aggregate({
          where: { createdAt: { gte: lastWeek }, status: 'SUCCEEDED' },
          _sum: { amountCents: true },
        }),
        this.prisma.payment.groupBy({
          by: ['status'],
          where: { createdAt: { gte: today } },
          _count: { _all: true },
        }),
      ]);

    const todayGross = todayAggregate._sum.amountCents ?? 0;
    const todayRefunded = todayRefunds._sum.amountCents ?? 0;
    const weekGross = weekAggregate._sum.amountCents ?? 0;
    const weekRefunded = weekRefunds._sum.amountCents ?? 0;

    return {
      today: {
        count: todayAggregate._count._all,
        grossCents: todayGross,
        refundedCents: todayRefunded,
        netCents: todayGross - todayRefunded,
      },
      week: {
        count: weekAggregate._count._all,
        grossCents: weekGross,
        refundedCents: weekRefunded,
        netCents: weekGross - weekRefunded,
      },
      statusBreakdown: statusBreakdown.reduce<Record<string, number>>((acc, row) => {
        acc[row.status] = row._count._all;
        return acc;
      }, {}),
    };
  }

  /**
   * Kill-switch: revoca todos los refresh tokens activos de un usuario del propio venue.
   * Solo OWNER. Util cuando un manager pierde el movil — corta acceso futuro,
   * el access token vivo se invalidara solo cuando expire (max 12h).
   *
   * El middleware de Prisma garantiza que el findUnique solo encuentre users
   * del tenant del caller — un OWNER de Luna VLC no puede revocar a un manager
   * de Luna MAD aunque conozca el userId.
   */
  @Post('users/:userId/revoke-sessions')
  @HttpCode(200)
  @Roles('OWNER')
  async revokeUserSessions(
    @Tenant() tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ): Promise<{ revoked: number; userId: string }> {
    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, tenantId: true },
    });
    if (!target || target.tenantId !== tenantId) {
      throw new NotFoundException('User not found');
    }

    const revoked = await this.refreshTokens.revokeAllForUser(userId);

    const ctx = this.cls.get('ctx');
    await this.audit.log({
      action: 'auth.sessions.revoked',
      tenantId,
      actorId: ctx?.userId,
      targetType: 'User',
      targetId: userId,
      payload: { revokedCount: revoked, targetEmail: target.email },
    });

    return { revoked, userId };
  }

  // ─── Ajustes del venue (parámetros editables por OWNER) ───────────

  @Get('venue/settings')
  @Roles('OWNER', 'MANAGER')
  async getVenueSettings(@Tenant() tenantId: string) {
    const venue = await this.prisma.asSystem((tx) =>
      tx.venue.findUniqueOrThrow({
        where: { id: tenantId },
        select: {
          id: true,
          name: true,
          slug: true,
          timezone: true,
          operatorMaxCobroCents: true,
          platformCommissionBps: true,
          operatorCommissionDefaults: true,
        },
      }),
    );
    return venue;
  }

  @Patch('venue/settings')
  @Roles('OWNER')
  async updateVenueSettings(
    @Tenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(VenueSettingsUpdateSchema)) dto: VenueSettingsUpdate,
  ) {
    if (Object.keys(dto).length === 0) {
      throw new NotFoundException('No hay campos a actualizar');
    }
    // operatorCommissionDefaults llega como mapa PARCIAL — hacemos merge con
    // los valores actuales para no machacar las claves que el admin no tocó.
    let mergedCommissionDefaults: Record<string, number> | undefined;
    if (dto.operatorCommissionDefaults) {
      const current = await this.prisma.asSystem((tx) =>
        tx.venue.findUniqueOrThrow({
          where: { id: tenantId },
          select: { operatorCommissionDefaults: true },
        }),
      );
      mergedCommissionDefaults = {
        ...(current.operatorCommissionDefaults as Record<string, number>),
        ...Object.fromEntries(
          Object.entries(dto.operatorCommissionDefaults).filter(([, v]) => v !== undefined),
        ),
      };
    }
    const updateData: Record<string, unknown> = {};
    if (dto.operatorMaxCobroCents !== undefined) updateData.operatorMaxCobroCents = dto.operatorMaxCobroCents;
    if (dto.platformCommissionBps !== undefined) updateData.platformCommissionBps = dto.platformCommissionBps;
    if (mergedCommissionDefaults) updateData.operatorCommissionDefaults = mergedCommissionDefaults;

    const updated = await this.prisma.asSystem((tx) =>
      tx.venue.update({
        where: { id: tenantId },
        data: updateData,
        select: {
          id: true,
          operatorMaxCobroCents: true,
          platformCommissionBps: true,
          operatorCommissionDefaults: true,
        },
      }),
    );
    await this.audit.log({
      action: 'venue.settings.updated',
      tenantId,
      actorId: user.sub,
      targetType: 'Venue',
      targetId: tenantId,
      payload: { changes: dto },
    });
    return updated;
  }

  // ─── Operadoras (chicas) ──────────────────────────────────────────

  @Get('operators')
  @Roles('OWNER', 'MANAGER')
  async listOperators(@Tenant() tenantId: string) {
    return this.operators.listVenueOperators(tenantId);
  }

  @Post('operators')
  @Roles('OWNER', 'MANAGER')
  async createOperator(
    @Tenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(CreateOperatorSchema)) dto: CreateOperatorDto,
  ) {
    return this.operators.createOperator(tenantId, user.sub, dto);
  }

  @Patch('operators/:id')
  @Roles('OWNER', 'MANAGER')
  async updateOperator(
    @Tenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(UpdateOperatorSchema)) dto: UpdateOperatorDto,
  ) {
    return this.operators.updateOperator(tenantId, id, user.sub, user.role, dto);
  }

  /**
   * Genera (o rota) el link self-onboarding para una operadora.
   * Admin lo manda a la chica via WhatsApp; ella abre el link sin login y
   * rellena su perfil. TTL 72h. Si no sabe manejar la web, el admin sigue
   * rellenando desde su tab Onboarding.
   */
  @Post('operators/:id/self-onboarding-link')
  @Roles('OWNER', 'MANAGER')
  @HttpCode(200)
  async createSelfOnboardingLink(
    @Tenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.operators.createSelfOnboardingLink(tenantId, id, user.sub);
  }

  @Get('operators/:id/earnings')
  @Roles('OWNER', 'MANAGER')
  async listOperatorEarnings(
    @Tenant() tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.operators.listOperatorEarnings(tenantId, id);
  }

  @Get('operators/:id/payouts')
  @Roles('OWNER', 'MANAGER')
  async listOperatorPayouts(
    @Tenant() tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.operators.listOperatorPayouts(tenantId, id);
  }

  /**
   * Marca payout — agrupa earnings pendientes y los liquida.
   * Restringido a OWNER (auditoría — payout = movimiento de dinero).
   */
  @Post('operators/:id/payouts')
  @Roles('OWNER')
  @HttpCode(201)
  async createOperatorPayout(
    @Tenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(CreatePayoutSchema)) dto: CreatePayoutDto,
  ) {
    return this.operators.createPayout(tenantId, id, user.sub, dto.notes, {
      externalTxId: dto.externalTxId,
      externalRail: dto.externalRail,
      receiptUrl: dto.receiptUrl,
    });
  }

  /**
   * Z-report (cierre de caja) para el periodo from→to. Default: hoy.
   *
   * Útil para:
   *  - Contabilidad nocturna del venue (sumas del día por categoría)
   *  - Reconciliación entre caja física, datáfono y NightPay
   *  - Reporte fiscal (Modelo 303 sale de esto trimestralmente)
   *
   * NO genera CSV/PDF — devuelve JSON. La UI admin se encarga de export.
   */
  @Get('reports/z')
  @Roles('OWNER', 'MANAGER')
  async zReport(
    @Tenant() tenantId: string,
    @Query(new ZodValidationPipe(ZReportQuerySchema)) q: ZReportQuery,
  ) {
    const fromDate = q.from ? new Date(q.from) : startOfDay(new Date());
    const toDate = q.to ? new Date(q.to) : new Date();
    if (fromDate >= toDate) {
      throw new NotFoundException('from debe ser anterior a to');
    }

    const range = { gte: fromDate, lt: toDate };

    // Todo en paralelo para que el reporte no tarde >2s con ~10k payments/día.
    const [
      paymentsAgg,
      refundsAgg,
      byMethod,
      byProvider,
      byZoneRows,
      byCategoryRows,
      topOperators,
      walletTopUps,
      walletConsumptions,
      earningsAgg,
      payoutsAgg,
    ] = await Promise.all([
      this.prisma.payment.aggregate({
        where: {
          createdAt: range,
          status: { in: ['AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
        },
        _sum: { amountCents: true, tipCents: true },
        _count: { _all: true },
      }),
      this.prisma.refund.aggregate({
        where: { createdAt: range, status: 'SUCCEEDED' },
        _sum: { amountCents: true },
        _count: { _all: true },
      }),
      this.prisma.payment.groupBy({
        by: ['captureMethod'],
        where: {
          createdAt: range,
          status: { in: ['AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
        },
        _sum: { amountCents: true },
        _count: { _all: true },
      }),
      this.prisma.payment.groupBy({
        by: ['provider'],
        where: {
          createdAt: range,
          status: { in: ['AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
        },
        _sum: { amountCents: true },
        _count: { _all: true },
      }),
      // Split por zona via JOIN con terminal — raw SQL es más eficiente que N+1 Prisma.
      this.prisma.$queryRaw<
        Array<{ zone: string | null; count: bigint; gross: bigint }>
      >`
        SELECT t.zone,
               COUNT(*)::bigint AS count,
               COALESCE(SUM(p."amountCents"),0)::bigint AS gross
          FROM payments p
          JOIN terminals t ON t.id = p."terminalId"
         WHERE p."tenantId" = ${tenantId}::uuid
           AND p."createdAt" >= ${fromDate}
           AND p."createdAt" < ${toDate}
           AND p.status IN ('AUTHORIZED','PARTIALLY_REFUNDED','REFUNDED')
         GROUP BY t.zone
         ORDER BY gross DESC
      `,
      // Split por categoría de ingreso (chicas vs local).
      this.prisma.$queryRaw<
        Array<{ revenueCategory: string; count: bigint; gross: bigint; tip: bigint }>
      >`
        SELECT "revenueCategory",
               COUNT(*)::bigint AS count,
               COALESCE(SUM("amountCents"),0)::bigint AS gross,
               COALESCE(SUM("tipCents"),0)::bigint AS tip
          FROM payments
         WHERE "tenantId" = ${tenantId}::uuid
           AND "createdAt" >= ${fromDate}
           AND "createdAt" < ${toDate}
           AND status IN ('AUTHORIZED','PARTIALLY_REFUNDED','REFUNDED')
         GROUP BY "revenueCategory"
         ORDER BY gross DESC
      `,
      // Top 5 operadoras por neto en el periodo.
      this.prisma.$queryRaw<
        Array<{
          operatorId: string;
          displayName: string | null;
          email: string;
          netCents: bigint;
          earningCount: bigint;
        }>
      >`
        SELECT e."operatorId",
               u."displayName",
               u.email,
               COALESCE(SUM(e."commissionCents" + COALESCE(e."tipCents",0) - e."reversedCents"),0)::bigint AS "netCents",
               COUNT(*)::bigint AS "earningCount"
          FROM operator_earnings e
          JOIN users u ON u.id = e."operatorId"
         WHERE e."tenantId" = ${tenantId}::uuid
           AND e."createdAt" >= ${fromDate}
           AND e."createdAt" < ${toDate}
         GROUP BY e."operatorId", u."displayName", u.email
         ORDER BY "netCents" DESC
         LIMIT 5
      `,
      // Wallet top-ups (payments con walletId set)
      this.prisma.payment.aggregate({
        where: {
          createdAt: range,
          walletId: { not: null },
          status: { in: ['AUTHORIZED', 'PARTIALLY_REFUNDED'] },
        },
        _sum: { amountCents: true },
        _count: { _all: true },
      }),
      // Wallet consumptions (gasto interno)
      this.prisma.walletConsumption.aggregate({
        where: { createdAt: range, reversedAt: null },
        _sum: { amountCents: true, tipCents: true },
        _count: { _all: true },
      }),
      // Earnings totales generados en el periodo (commission + tip - reversed)
      this.prisma.$queryRaw<Array<{ totalNet: bigint; count: bigint }>>`
        SELECT
          COALESCE(SUM("commissionCents" + COALESCE("tipCents",0) - "reversedCents"),0)::bigint AS "totalNet",
          COUNT(*)::bigint AS count
        FROM operator_earnings
        WHERE "tenantId" = ${tenantId}::uuid
          AND "createdAt" >= ${fromDate}
          AND "createdAt" < ${toDate}
      `,
      // Payouts ejecutados en el periodo
      this.prisma.operatorPayout.aggregate({
        where: { createdAt: range },
        _sum: { totalCents: true },
        _count: { _all: true },
      }),
    ]);

    const grossCents = paymentsAgg._sum.amountCents ?? 0;
    const tipCents = paymentsAgg._sum.tipCents ?? 0;
    const refundedCents = refundsAgg._sum.amountCents ?? 0;
    const netCents = grossCents + tipCents - refundedCents;

    return {
      period: { from: fromDate.toISOString(), to: toDate.toISOString() },
      summary: {
        paymentCount: paymentsAgg._count._all,
        grossCents,
        tipCents,
        refundedCents,
        netCents,
        refundCount: refundsAgg._count._all,
      },
      byCaptureMethod: byMethod.map((r) => ({
        method: r.captureMethod ?? 'QR',
        count: r._count._all,
        grossCents: r._sum.amountCents ?? 0,
      })),
      byProvider: byProvider.map((r) => ({
        provider: r.provider ?? 'NONE',
        count: r._count._all,
        grossCents: r._sum.amountCents ?? 0,
      })),
      byZone: byZoneRows.map((r) => ({
        zone: r.zone ?? 'SIN_ZONA',
        count: Number(r.count),
        grossCents: Number(r.gross),
      })),
      // Split por categoría de ingreso — separa cobros chicas vs cobros local.
      // El admin contable usa esto para imputar correctamente al P&L del local
      // vs lo que las chicas facturan como autónomas.
      byRevenueCategory: byCategoryRows.map((r) => ({
        category: r.revenueCategory,
        count: Number(r.count),
        grossCents: Number(r.gross),
        tipCents: Number(r.tip),
      })),
      // Totales agregados chica vs local (atajo para dashboards).
      chicaRevenue: byCategoryRows
        .filter((r) => r.revenueCategory === 'CHICA_SERVICE')
        .reduce(
          (acc, r) => ({
            count: acc.count + Number(r.count),
            grossCents: acc.grossCents + Number(r.gross),
          }),
          { count: 0, grossCents: 0 },
        ),
      venueRevenue: byCategoryRows
        .filter((r) => r.revenueCategory !== 'CHICA_SERVICE')
        .reduce(
          (acc, r) => ({
            count: acc.count + Number(r.count),
            grossCents: acc.grossCents + Number(r.gross),
          }),
          { count: 0, grossCents: 0 },
        ),
      topOperators: topOperators.map((r) => ({
        operatorId: r.operatorId,
        displayName: r.displayName,
        email: r.email,
        netCents: Number(r.netCents),
        earningCount: Number(r.earningCount),
      })),
      wallet: {
        topUpCount: walletTopUps._count._all,
        topUpCents: walletTopUps._sum.amountCents ?? 0,
        consumptionCount: walletConsumptions._count._all,
        consumptionCents: walletConsumptions._sum.amountCents ?? 0,
        consumptionTipCents: walletConsumptions._sum.tipCents ?? 0,
      },
      earnings: {
        count: Number(earningsAgg[0]?.count ?? 0),
        totalNetCents: Number(earningsAgg[0]?.totalNet ?? 0),
      },
      payouts: {
        count: payoutsAgg._count._all,
        totalCents: payoutsAgg._sum.totalCents ?? 0,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Modelo 303 — desglose IVA trimestral para presentación AEAT.
   *
   * Calcula sobre los cobros AUTHORIZED+PARTIALLY_REFUNDED+REFUNDED del
   * trimestre (con tip incluido — Hacienda considera propina como base
   * imponible si va al negocio; si va a la chica como autónoma, ella
   * tributa aparte y NO debería sumar aquí — simplificación Phase 1).
   *
   * El admin solo OWNER puede consultar (datos fiscales).
   */
  @Get('reports/vat-303')
  @Roles('OWNER')
  async vatReport(
    @Tenant() tenantId: string,
    @Query(new ZodValidationPipe(VatReportQuerySchema)) q: VatReportQuery,
  ) {
    const { from, to, label } = quarterRange(q.quarter);

    const venue = await this.prisma.venue.findUniqueOrThrow({
      where: { id: tenantId },
      select: { name: true, vatBps: true, vatRegime: true },
    });

    if (venue.vatRegime === 'EXENTO') {
      return {
        quarter: label,
        from: from.toISOString(),
        to: to.toISOString(),
        venue: { name: venue.name, vatBps: venue.vatBps, vatRegime: venue.vatRegime },
        exento: true,
        message: 'Venue en régimen EXENTO — no aplica Modelo 303',
      };
    }

    // Total cobrado neto en el trimestre (importe + tip - refunds)
    const [paymentsAgg, refundsAgg, walletConsAgg, byMonthRows] = await Promise.all([
      this.prisma.payment.aggregate({
        where: {
          createdAt: { gte: from, lt: to },
          status: { in: ['AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
        },
        _sum: { amountCents: true, tipCents: true },
      }),
      this.prisma.refund.aggregate({
        where: { createdAt: { gte: from, lt: to }, status: 'SUCCEEDED' },
        _sum: { amountCents: true },
      }),
      // Consumos wallet: el dinero del top-up ya entró al venue (cuenta como
      // factura emitida al cargar), los consumos son operaciones internas y
      // NO añaden facturación. Solo lo incluimos como informativo.
      this.prisma.walletConsumption.aggregate({
        where: { createdAt: { gte: from, lt: to }, reversedAt: null },
        _sum: { amountCents: true, tipCents: true },
        _count: { _all: true },
      }),
      // Desglose mensual (3 meses) — JOIN agrupado en lugar de correlated subquery
      this.prisma.$queryRaw<
        Array<{ month: Date; gross: bigint; tips: bigint; refunds: bigint }>
      >`
        WITH monthly_payments AS (
          SELECT
            DATE_TRUNC('month', "createdAt") AS month,
            COALESCE(SUM("amountCents"),0)::bigint AS gross,
            COALESCE(SUM("tipCents"),0)::bigint AS tips
          FROM payments
          WHERE "tenantId" = ${tenantId}::uuid
            AND "createdAt" >= ${from}
            AND "createdAt" < ${to}
            AND status IN ('AUTHORIZED','PARTIALLY_REFUNDED','REFUNDED')
          GROUP BY DATE_TRUNC('month', "createdAt")
        ),
        monthly_refunds AS (
          SELECT
            DATE_TRUNC('month', "createdAt") AS month,
            COALESCE(SUM("amountCents"),0)::bigint AS refunds
          FROM refunds
          WHERE "tenantId" = ${tenantId}::uuid
            AND status = 'SUCCEEDED'
            AND "createdAt" >= ${from}
            AND "createdAt" < ${to}
          GROUP BY DATE_TRUNC('month', "createdAt")
        )
        SELECT
          p.month,
          p.gross,
          p.tips,
          COALESCE(r.refunds, 0)::bigint AS refunds
        FROM monthly_payments p
        LEFT JOIN monthly_refunds r ON r.month = p.month
        ORDER BY p.month ASC
      `,
    ]);

    const grossCents = paymentsAgg._sum.amountCents ?? 0;
    const tipCents = paymentsAgg._sum.tipCents ?? 0;
    const refundedCents = refundsAgg._sum.amountCents ?? 0;
    const netCobradoCents = grossCents + tipCents - refundedCents;

    // Base imponible = neto / (1 + vat/10000). IVA = neto - base.
    // round half-even para no acumular bias.
    const vatRatio = 1 + venue.vatBps / 10_000;
    const baseImponibleCents = Math.round(netCobradoCents / vatRatio);
    const cuotaIvaCents = netCobradoCents - baseImponibleCents;

    return {
      quarter: label,
      from: from.toISOString(),
      to: to.toISOString(),
      venue: {
        name: venue.name,
        vatBps: venue.vatBps,
        vatPercent: venue.vatBps / 100,
        vatRegime: venue.vatRegime,
      },
      // Casillas Modelo 303 (régimen general, simplificación Phase 1):
      modelo303: {
        // Casilla 01: Base imponible al tipo del venue
        baseImponibleCents,
        // Casilla 03: IVA devengado (cuota)
        cuotaIvaCents,
        // Total facturado (informativo)
        totalFacturadoCents: netCobradoCents,
        // Casilla 14 (informativo): IVA a ingresar (asumimos sin deducciones
        // — eso requiere registrar facturas de gasto, fuera de scope NightPay)
        ivaAIngresarCents: cuotaIvaCents,
      },
      breakdown: {
        grossCents,
        tipCents,
        refundedCents,
        netCobradoCents,
      },
      walletInfo: {
        consumptionCount: walletConsAgg._count._all,
        consumptionCents: walletConsAgg._sum.amountCents ?? 0,
        note: 'Consumos wallet son operaciones internas — no facturan al cliente final. El IVA se facturó al cargar la wallet (top-up).',
      },
      byMonth: byMonthRows.map((r) => {
        const net = Number(r.gross) + Number(r.tips) - Number(r.refunds);
        const base = Math.round(net / vatRatio);
        return {
          month: r.month.toISOString().slice(0, 7),
          grossCents: Number(r.gross),
          tipCents: Number(r.tips),
          refundedCents: Number(r.refunds),
          netCents: net,
          baseImponibleCents: base,
          cuotaIvaCents: net - base,
        };
      }),
      disclaimer:
        'Reporte automático sin auditoría fiscal. Verifica con tu asesor antes de presentar Modelo 303. ' +
        'Recargo de equivalencia + facturas de gasto deducibles requieren tratamiento manual.',
      generatedAt: new Date().toISOString(),
    };
  }
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
