import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Logger,
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
import { TotpService } from '../auth/totp.service';
import { AuditService } from '../audit/audit.service';
import { OperatorsService } from '../operators/operators.service';
import { PaymentsService } from '../payments/payments.service';
import { InvalidTransitionError } from '../payments/payment.machine';
import { chargedAttemptTip } from '../payments/tip';
import { ClsService } from 'nestjs-cls';
import {
  CreateOperatorSchema,
  CreatePayoutSchema,
  ResetOperatorPasswordSchema,
  UpdateOperatorSchema,
  type CreateOperatorDto,
  type CreatePayoutDto,
  type JwtPayload,
  type PaymentStatus,
  type ResetOperatorPasswordDto,
  type UpdateOperatorDto,
} from '@nightpay/contracts';
import type { RequestContext } from '../../common/context/request-context';

const CreateVenueSchema = z.object({
  name: z.string().min(2).max(80),
  slug: z
    .string()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Slug debe ser kebab-case (ej. mi-local-vlc)'),
  timezone: z.string().max(50).optional(),
});
type CreateVenueDto = z.infer<typeof CreateVenueSchema>;

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


/** Un AUTHORIZING sin aviso del banco durante este tiempo se puede resolver a mano. */
const STUCK_AUTHORIZING_MS = 15 * 60 * 1000;

/**
 * Resolver un pago atascado. Para darlo por cobrado hace falta el código de
 * autorización que muestra el portal del banco (o el ticket): sin él, nadie
 * puede "aprobar" un cobro que no existe.
 */
const ManualReconcileSchema = z
  .object({
    decision: z.enum(['AUTHORIZED', 'FAILED']),
    reason: z.string().min(3).max(500),
    bankAuthCode: z
      .string()
      .transform((s) => s.replace(/\s+/g, '').toUpperCase())
      .pipe(z.string().regex(/^[A-Z0-9]{6}$/, 'Código de autorización: 6 letras o números'))
      .optional(),
    // Fase 1B: pedido que cobró el banco (si hubo varios intentos con
    // propinas distintas), para saber qué propina le toca a la chica.
    bankOrder: z.string().trim().regex(/^[0-9A-Za-z]{4,12}$/, 'Número de pedido no válido').optional(),
  })
  .refine((b) => b.decision !== 'AUTHORIZED' || Boolean(b.bankAuthCode), {
    message: 'Para marcarlo cobrado, pon el código de autorización del banco',
    path: ['bankAuthCode'],
  });

@Controller('admin')
@UseGuards(RolesGuard)
export class AdminController {
  private readonly logger = new Logger(AdminController.name);

  private readonly prisma: PrismaService;
  private readonly refreshTokens: RefreshTokenService;
  private readonly audit: AuditService;
  private readonly operators: OperatorsService;
  private readonly payments: PaymentsService;
  private readonly cls: ClsService<{ ctx: RequestContext }>;
  private readonly totp: TotpService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(RefreshTokenService) refreshTokens: RefreshTokenService,
    @Inject(AuditService) audit: AuditService,
    @Inject(OperatorsService) operators: OperatorsService,
    @Inject(PaymentsService) payments: PaymentsService,
    @Inject(ClsService) cls: ClsService<{ ctx: RequestContext }>,
    @Inject(TotpService) totp: TotpService,
  ) {
    this.prisma = prisma;
    this.refreshTokens = refreshTokens;
    this.audit = audit;
    this.operators = operators;
    this.payments = payments;
    this.cls = cls;
    this.totp = totp;
  }

  /**
   * Endpoint TEMPORAL de diagnóstico — retorna el estado de la DB para
   * detectar errores 500 cuando el log no es accesible.
   * Devuelve: tabla migrations (últimas 10), venues + gateway_credentials,
   * existencia de columnas críticas, terminals por venue. Solo OWNER.
   */
  @Get('debug-state')
  @Roles('OWNER', 'MANAGER')
  async debugState(@CurrentUser() user: JwtPayload) {
    // Enseña todos los locales: solo superadmin.
    await this.assertSuperAdmin(user.sub);
    const result: Record<string, unknown> = {};
    result.actor = {
      userId: user.sub,
      role: user.role,
      tenantId: user.tenantId,
      venueSlug: user.venueSlug,
    };

    try {
      const migrations = await this.prisma.asSystem((tx) =>
        tx.$queryRaw<Array<{ migration_name: string; finished_at: Date | null }>>`
          SELECT migration_name, finished_at
            FROM _prisma_migrations
           ORDER BY started_at DESC
           LIMIT 10
        `,
      );
      result.recentMigrations = migrations.map((m) => ({
        name: m.migration_name,
        finishedAt: m.finished_at?.toISOString() ?? null,
      }));
    } catch (e) {
      result.migrationsError = (e as Error).message;
    }

    try {
      const cols = await this.prisma.asSystem((tx) =>
        tx.$queryRaw<Array<{ column_name: string }>>`
          SELECT column_name
            FROM information_schema.columns
           WHERE table_name = 'payments'
             AND column_name IN ('revenueCategory', 'tipCents', 'platformCommissionBps')
        `,
      );
      result.paymentsColumnsExist = cols.map((c) => c.column_name);
    } catch (e) {
      result.columnsError = (e as Error).message;
    }

    try {
      const venues = await this.prisma.asSystem((tx) =>
        tx.venue.findMany({
          where: { deletedAt: null },
          select: {
            id: true,
            slug: true,
            operatorCommissionDefaults: true,
            gatewayCredentials: { select: { provider: true, active: true } },
            terminals: { select: { externalId: true, zone: true, active: true } },
          },
        }),
      );
      result.venues = venues;
    } catch (e) {
      result.venuesError = (e as Error).message;
    }

    try {
      const users = await this.prisma.asSystem((tx) =>
        tx.user.findMany({
          where: { tenantId: user.tenantId },
          select: {
            email: true,
            role: true,
            isSuperAdmin: true,
            commissionBps: true,
          },
        }),
      );
      result.usersInActiveTenant = users;
    } catch (e) {
      result.usersError = (e as Error).message;
    }

    return result;
  }

  // ─── Venues admin (multi-tenant super-admin) ──────────────────────
  //
  // Endpoints SOLO accesibles por usuarios con isSuperAdmin=true. Permiten
  // listar todos los locales y crear nuevos. Para switchear el tenant activo
  // del JWT, usar POST /v1/auth/switch-tenant.
  //
  // El chequeo isSuperAdmin se hace en el método (no en decorator) porque
  // RolesGuard solo entiende el enum Role — añadir SUPER_ADMIN al enum
  // implicaría tocar muchas rutas. Más simple: query manual.

  @Get('venues')
  @Roles('OWNER', 'MANAGER') // necesario para pasar RolesGuard; chequeo real abajo
  async listAllVenues(@CurrentUser() user: JwtPayload) {
    await this.assertSuperAdmin(user.sub);
    const venues = await this.prisma.asSystem((tx) =>
      tx.venue.findMany({
        where: { deletedAt: null },
        select: {
          id: true,
          name: true,
          slug: true,
          timezone: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
    );
    return venues.map((v) => ({
      id: v.id,
      name: v.name,
      slug: v.slug,
      timezone: v.timezone,
      createdAt: v.createdAt.toISOString(),
    }));
  }

  @Post('venues')
  @Roles('OWNER', 'MANAGER')
  @HttpCode(201)
  async createVenue(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(CreateVenueSchema)) dto: CreateVenueDto,
  ) {
    await this.assertSuperAdmin(user.sub);
    // Slug debe ser único + kebab-case ya validado en zod.
    const existing = await this.prisma.asSystem((tx) =>
      tx.venue.findUnique({ where: { slug: dto.slug }, select: { id: true } }),
    );
    if (existing) {
      throw new ConflictException(`Slug "${dto.slug}" ya está en uso`);
    }
    const venue = await this.prisma.asSystem((tx) =>
      tx.venue.create({
        data: {
          name: dto.name,
          slug: dto.slug,
          timezone: dto.timezone ?? 'Europe/Madrid',
        },
        select: { id: true, name: true, slug: true, timezone: true, createdAt: true },
      }),
    );
    await this.audit.log({
      action: 'venue.created',
      tenantId: venue.id,
      actorId: user.sub,
      targetType: 'Venue',
      targetId: venue.id,
      payload: { name: venue.name, slug: venue.slug },
    });
    this.logger.log(`Venue created: ${venue.slug} by super_admin ${user.sub}`);
    return {
      id: venue.id,
      name: venue.name,
      slug: venue.slug,
      timezone: venue.timezone,
      createdAt: venue.createdAt.toISOString(),
    };
  }

  /** Helper: lanza 403 si el user no es super admin. */
  private async assertSuperAdmin(userId: string): Promise<void> {
    // El super-admin pertenece a SU local: con otro local activo, el filtro por
    // local del middleware no lo encontraría (403/401). acrossVenues lo quita.
    const u = await this.prisma.acrossVenues((tx) =>
      tx.user.findUnique({
        where: { id: userId },
        select: { isSuperAdmin: true, deletedAt: true },
      }),
    );
    if (!u || u.deletedAt || !u.isSuperAdmin) {
      throw new ForbiddenException('Solo super admins pueden gestionar locales');
    }
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
        authCode: true,
        cardLast4: true,
        cardBrand: true,
        payMethodCode: true,
        authorizedAt: true,
        // Todos los pedidos enviados al banco (un cobro puede tener varios
        // intentos): para buscarlos en el portal al resolver a mano.
        attempts: {
          select: { providerTxId: true, status: true, createdAt: true, amountCents: true, tipCents: true },
          orderBy: { createdAt: 'asc' },
        },
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
   * Reconciliación manual de un pago atascado en ORPHAN.
   *
   * Cuando el webhook de la pasarela no llega y la consulta REST tampoco
   * funciona (SIS0105 — operador no autorizado, banco con feature off),
   * los pagos quedan ORPHAN. El admin verifica el estado en el panel del
   * banco y aquí lo marca como AUTHORIZED o FAILED para cerrar el ciclo.
   *
   * Solo OWNER puede hacerlo (impacto financiero directo). Auditado.
   * Solo pagos en ORPHAN — no se puede manipular otros estados.
   */
  @Post('payments/:id/manual-reconcile')
  @Roles('OWNER')
  @HttpCode(200)
  async manualReconcile(
    @Param('id', ParseUUIDPipe) paymentId: string,
    @Tenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(ManualReconcileSchema))
    body: z.infer<typeof ManualReconcileSchema>,
  ): Promise<{ ok: true; newStatus: string }> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: {
        id: true,
        status: true,
        provider: true,
        providerTxId: true,
        tenantId: true,
        updatedAt: true,
      },
    });
    if (!payment) {
      throw new NotFoundException('Payment not found');
    }
    if (payment.tenantId !== tenantId) {
      throw new ForbiddenException('Cross-tenant payment');
    }
    // ORPHAN (el banco no confirmó a tiempo) o AUTHORIZING atascado: más de
    // 15 min sin aviso del banco. Antes de eso el aviso aún puede llegar.
    const stuckAuthorizing =
      payment.status === 'AUTHORIZING' &&
      Date.now() - payment.updatedAt.getTime() >= STUCK_AUTHORIZING_MS;
    if (payment.status !== 'ORPHAN' && !stuckAuthorizing) {
      throw new ConflictException(
        payment.status === 'AUTHORIZING'
          ? 'Este pago lleva menos de 15 minutos esperando al banco. Espera a que llegue el aviso.'
          : `Solo se resuelven a mano pagos sin confirmar o atascados — este está en ${payment.status}`,
      );
    }

    const authCode = body.decision === 'AUTHORIZED' ? body.bankAuthCode ?? null : null;
    try {
      if (body.decision === 'AUTHORIZED') {
        if (!payment.provider || !payment.providerTxId) {
          throw new ConflictException('Pago sin provider/providerTxId — no se puede marcar AUTHORIZED');
        }
        await this.checkResolvedTip(paymentId, body.bankOrder);
        // El pedido cobrado (si se eligió) fija la propina en transition()
        // y queda como pedido del cobro, para devolverlo en el banco.
        await this.payments.transition(paymentId, {
          type: 'AUTHORIZED',
          provider: payment.provider,
          providerTxId: body.bankOrder ?? payment.providerTxId,
        });
        // Si llegó un aviso tardío con los datos del banco, no se pisan.
        await this.prisma.payment.updateMany({
          where: { id: paymentId, authorizedAt: null },
          data: { authCode, authorizedAt: new Date() },
        });
      } else {
        // AUTHORIZING no puede ir directo a FAILED sin pasar por ORPHAN.
        if (payment.status === 'AUTHORIZING') {
          await this.payments.transition(paymentId, { type: 'TIMEOUT' });
        }
        await this.payments.transition(paymentId, {
          type: 'FAILED',
          reason: `manual-reconcile: ${body.reason}`,
        });
      }
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        throw new ConflictException(
          `Transición rechazada: ${err.message} — el estado del pago cambió mientras hacías esto`,
        );
      }
      throw err;
    }

    await this.audit.log({
      action: 'payment.manual_reconcile',
      tenantId,
      actorId: user.sub,
      targetType: 'Payment',
      targetId: paymentId,
      payload: {
        decision: body.decision,
        reason: body.reason,
        bankAuthCode: authCode,
        bankOrder: body.bankOrder ?? null,
        fromStatus: payment.status,
      },
    });

    this.logger.warn(
      `Manual reconcile by ${user.sub}: payment=${paymentId} ${payment.status} → ${body.decision} auth=${authCode ?? '-'} (reason: ${body.reason})`,
    );

    return { ok: true, newStatus: body.decision };
  }

  /**
   * Fase 1B: cada intento puede llevar una propina distinta. Si no se sabe
   * qué pedido cobró el banco, no se puede saber qué propina le toca a la
   * chica: hay que elegirlo. Los intentos denegados no cuentan, y los cobros
   * sin intentos registrados (anteriores a la Fase 0) no se bloquean.
   */
  private async checkResolvedTip(paymentId: string, bankOrder: string | undefined): Promise<void> {
    const attempts = await this.prisma.asSystem((tx) =>
      tx.paymentAttempt.findMany({
        where: { paymentId, status: { not: 'DENIED' } },
        select: { providerTxId: true, tipCents: true },
      }),
    );
    if (attempts.length === 0) return;
    const charged = chargedAttemptTip(attempts, bankOrder);
    if (!charged.ok) {
      throw new BadRequestException(
        charged.reason === 'unknown-order'
          ? 'Ese número de pedido no es de este cobro'
          : 'Este cobro tuvo varios intentos con propinas distintas: elige el pedido que aparece en el portal del banco',
      );
    }
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

  /**
   * Re-emite invite link para una operadora con activación pendiente.
   * Caso de uso: el primer invite expiró (TTL 24h) o nunca llegó por email
   * y el admin no copió la URL.
   * Si la chica ya activó password (invitedAt=null), 409 — usar reset-password.
   */
  @Post('operators/:id/regenerate-invite')
  @Roles('OWNER', 'MANAGER')
  @HttpCode(200)
  async regenerateInvite(
    @Tenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.operators.regenerateInvite(tenantId, id, user.sub);
  }

  /**
   * Resetea la contraseña de una operadora. Body opcional:
   *   - { password: "X..." } → admin la define explícita (mín 8 chars)
   *   - {} (vacío)           → backend genera random 12 chars
   * Response devuelve la password EN CLARO una sola vez para que el admin la
   * copie y se la envíe por WhatsApp. NightPay nunca la persiste en claro.
   */
  // Solo el dueño: con una contraseña nueva se entra como la chica.
  @Post('operators/:id/reset-password')
  @Roles('OWNER')
  @HttpCode(200)
  async resetPassword(
    @Tenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(ResetOperatorPasswordSchema)) body: ResetOperatorPasswordDto,
  ) {
    return this.operators.resetPassword(tenantId, id, user.sub, body.password ? body.password : null);
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
    // Pagar a una chica mueve dinero: con 2FA activada, hace falta el código
    // (una sesión robada no basta para mandar su dinero a otra cuenta).
    const payer = await this.prisma.acrossVenues((tx) =>
      tx.user.findUnique({ where: { id: user.sub }, select: { totpSecret: true } }),
    );
    this.totp.assertIfEnrolled(payer?.totpSecret, dto.totpCode);
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
