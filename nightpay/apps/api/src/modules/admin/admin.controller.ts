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
    const updated = await this.prisma.asSystem((tx) =>
      tx.venue.update({
        where: { id: tenantId },
        data: dto,
        select: {
          id: true,
          operatorMaxCobroCents: true,
          platformCommissionBps: true,
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
    return this.operators.updateOperator(tenantId, id, user.sub, dto);
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
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
