import { stepUpActions } from '@nightpay/contracts';
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
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { OptionalIdempotencyKey } from '../../common/decorators/idempotent.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Tenant } from '../../common/decorators/tenant.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ApprovalRequestsService } from '../approvals/approval-requests.service';
import { assertNoPendingPayout } from '../approvals/approval-store';
import { RefreshTokenService } from '../auth/refresh-token.service';
import { TotpService } from '../auth/totp.service';
import { AuditService } from '../audit/audit.service';
import { OperatorsService } from '../operators/operators.service';
import { isPayeeRole } from '../operators/payee-roles';
import { payoutRequestHash } from '../operators/payout-idempotency';
import { touchesPayoutAccount } from '../operators/payout-routing';
import { PaymentsService } from '../payments/payments.service';
import { InvalidTransitionError } from '../payments/payment.machine';
import { chargedAttemptTip } from '../payments/tip';
import { planVenueRulesChange } from '../superadmin/superadmin-rules';
import { resolveHoldDays } from '../operators/payout-math';
import { RequiresPermission, StaffPermissionGuard } from '../venues/staff-permission.guard';
import { newVenuePaymentMethods } from '../venues/venue-methods';
import { ClsService } from 'nestjs-cls';
import {
  MAX_OPERATOR_COBRO_CENTS,
  MAX_VENUE_PAYOUT_HOLD_DAYS,
  CreateOperatorSchema,
  CreatePayoutSchema,
  ResetOperatorPasswordSchema,
  ServiceFeeBpsSchema,
  UpdateOperatorSchema,
  type CreateOperatorDto,
  type CreatePayoutDto,
  type JwtPayload,
  type PaymentStatus,
  type ResetOperatorPasswordDto,
  type UpdateOperatorDto,
} from '@nightpay/contracts';
import type { RequestContext } from '../../common/context/request-context';
import { MIN_INVOICE_REF_LENGTH, invoiceRefProblem, matchInvoiceRef } from '../btcpay/btcpay-resolve';

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

export const VenueSettingsUpdateSchema = z.object({
  operatorMaxCobroCents: z.number().int().min(0).max(10_000_00).optional(),
  // La comisión de la plataforma solo la cambia el super-admin (consola, con
  // 2FA). Aquí se acepta sin cambios (el panel anterior la manda siempre);
  // otro valor → 403.
  platformCommissionBps: z.number().int().min(0).max(10_000).optional(),
  // Comisiones por categoría — admin puede editar el mapa entero o solo
  // algunas claves. Las omitidas mantienen su valor actual.
  operatorCommissionDefaults: z.object({
    CHICA_SERVICE: z.number().int().min(0).max(10_000).optional(),
    VENUE_BAR: z.number().int().min(0).max(10_000).optional(),
    VENUE_ROOM: z.number().int().min(0).max(10_000).optional(),
    VENUE_FOOD: z.number().int().min(0).max(10_000).optional(),
    VENUE_ENTRY: z.number().int().min(0).max(10_000).optional(),
    EXTRA: z.number().int().min(0).max(10_000).optional(),
  }).optional(),
  // Reglas del local que pone el dueño (Ajustes → Reglas del local).
  /** null = el del entorno (PAYOUT_HOLD_DAYS). 0 = se paga al cierre de la noche. */
  payoutHoldDays: z.number().int().min(0).max(MAX_VENUE_PAYOUT_HOLD_DAYS).nullable().optional(),
  refundApprovalThresholdCents: z.number().int().min(0).max(MAX_OPERATOR_COBRO_CENTS).optional(),
  payoutRequiresApproval: z.boolean().optional(),
  // «Comisión del servicio al cliente»: la enciende y fija OxioPay (super-admin,
  // con 2FA). Aquí se acepta sin cambios; otro valor → 403, como la de la plataforma.
  serviceFeeEnabled: z.boolean().optional(),
  serviceFeeBps: ServiceFeeBpsSchema.optional(),
  topUpServiceFeeBps: ServiceFeeBpsSchema.optional(),
  /** Reglas de dinero: con la 2FA activada, el código. */
  totpCode: z.string().regex(/^\d{6}$/, 'El código 2FA son 6 cifras').optional(),
});
type VenueSettingsUpdate = z.infer<typeof VenueSettingsUpdateSchema>;

/** Lo que enseña y cambia el dueño en Ajustes (la comisión de OxioPay solo se enseña). */
const VENUE_SETTINGS_SELECT = {
  id: true,
  name: true,
  slug: true,
  timezone: true,
  operatorMaxCobroCents: true,
  platformCommissionBps: true,
  operatorCommissionDefaults: true,
  payoutHoldDays: true,
  refundApprovalThresholdCents: true,
  payoutRequiresApproval: true,
  // «Comisión del servicio al cliente»: el dueño la ve (Ajustes → Reglas), no la cambia.
  serviceFeeEnabled: true,
  serviceFeeBps: true,
  topUpServiceFeeBps: true,
} as const;

/** Con los días de espera que valen de verdad (los del local o los del entorno). */
function withEffectiveHoldDays<T extends { payoutHoldDays: number | null }>(v: T): T & { effectivePayoutHoldDays: number } {
  return { ...v, effectivePayoutHoldDays: resolveHoldDays(v.payoutHoldDays, process.env.PAYOUT_HOLD_DAYS) };
}

const MSG_PLATFORM_COMMISSION_SA_ONLY = 'La comisión de OxioPay solo la cambia OxioPay (super-admin)';
const MSG_SERVICE_FEE_SA_ONLY = 'La comisión del servicio solo la cambia OxioPay (super-admin)';

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
 * Métricas, Z del periodo e IVA 303 están en reports/ (PeriodReportsController),
 * con las mismas reglas que el resto de informes. El trimestre del IVA (en hora
 * de Madrid) se reexporta aquí por compatibilidad.
 */
export { madridQuarter as quarterRange } from '../reports/reporting-window';


/** Un AUTHORIZING sin aviso del banco durante este tiempo se puede resolver a mano. */
const STUCK_AUTHORIZING_MS = 15 * 60 * 1000;

/**
 * Resolver un pago atascado. Para darlo por cobrado hace falta el código de
 * autorización que muestra el portal del banco (o el ticket): sin él, nadie
 * puede "aprobar" un cobro que no existe. Con bitcoin (BTCPay) no hay banco: el
 * id de su factura de BTCPay (o un trozo), que se copia de la factura.
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
    /** Bitcoin: el id de la factura de BTCPay (entero, un trozo o su enlace). */
    btcpayInvoiceRef: z.string().trim().min(MIN_INVOICE_REF_LENGTH, `El id de la factura: al menos ${MIN_INVOICE_REF_LENGTH} letras o números`).max(300).optional(),
    /** Darlo por cobrado sube un saldo sin que el banco lo diga: con el 2FA del dueño. */
    totpCode: z.string().regex(/^\d{6}$/, 'El código 2FA son 6 cifras').optional(),
  })
  .refine((b) => b.decision !== 'AUTHORIZED' || Boolean(b.bankAuthCode) || Boolean(b.btcpayInvoiceRef), {
    message: 'Para marcarlo cobrado, pon el código de autorización del banco (o, con bitcoin, el id de la factura de BTCPay)',
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
  private readonly approvals: ApprovalRequestsService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(RefreshTokenService) refreshTokens: RefreshTokenService,
    @Inject(AuditService) audit: AuditService,
    @Inject(OperatorsService) operators: OperatorsService,
    @Inject(PaymentsService) payments: PaymentsService,
    @Inject(ClsService) cls: ClsService<{ ctx: RequestContext }>,
    @Inject(TotpService) totp: TotpService,
    @Inject(ApprovalRequestsService) approvals: ApprovalRequestsService,
  ) {
    this.prisma = prisma;
    this.refreshTokens = refreshTokens;
    this.audit = audit;
    this.operators = operators;
    this.payments = payments;
    this.cls = cls;
    this.totp = totp;
    this.approvals = approvals;
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
          // Local nuevo: datáfono apagado de fábrica (los de antes no cambian).
          paymentMethods: { ...newVenuePaymentMethods() },
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
        // «Comisión del servicio»: la que pagó el cliente encima y si era una recarga (no se devuelve).
        serviceFeeCents: true,
        tipCents: true,
        walletId: true,
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
   * Cuando el aviso de la pasarela no llega y la consulta a la pasarela no
   * lo confirma, los pagos quedan ORPHAN. Con Redsys hoy siempre: su
   * consulta no está disponible (el SIS0105 de antes venía de mandar el tipo
   * 44, «Borrar Referencia», no de un permiso que faltara en BBVA; la
   * consulta de verdad, SOAP SerClsWSConsulta, está pendiente de BBVA). El
   * admin verifica el estado en el panel del banco y aquí lo marca como
   * AUTHORIZED o FAILED para cerrar el ciclo.
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
        posOperationNumber: true,
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
    // Una venta del datáfono sin la prueba de Paytef (recarga en la recepción)
    // no espera a ningún aviso: se resuelve al momento, mirando el panel de Paytef.
    const stuckAuthorizing =
      payment.status === 'AUTHORIZING' &&
      (Boolean(payment.posOperationNumber) || Date.now() - payment.updatedAt.getTime() >= STUCK_AUTHORIZING_MS);
    if (payment.status !== 'ORPHAN' && !stuckAuthorizing) {
      throw new ConflictException(
        payment.status === 'AUTHORIZING'
          ? 'Este pago lleva menos de 15 minutos esperando al banco. Espera a que llegue el aviso.'
          : `Solo se resuelven a mano pagos sin confirmar o atascados — este está en ${payment.status}`,
      );
    }

    // Antes del 2FA (no gasta un intento): con bitcoin, la factura; con el banco, su código.
    const btcInvoice = body.decision === 'AUTHORIZED' ? await this.resolvedBitcoinInvoice(payment, body) : null;
    if (body.decision === 'AUTHORIZED') await this.totp.assertForUser(user.sub, body.totpCode, stepUpActions.resolvePayment(payment.id));
    const authCode = body.decision === 'AUTHORIZED' && !btcInvoice ? body.bankAuthCode ?? null : null;
    const chargedOrder = btcInvoice ?? body.bankOrder;
    try {
      if (body.decision === 'AUTHORIZED') {
        if (!payment.provider || !payment.providerTxId) {
          throw new ConflictException('Pago sin provider/providerTxId — no se puede marcar AUTHORIZED');
        }
        await this.checkResolvedTip(paymentId, chargedOrder, payment.providerTxId);
        // El pedido cobrado (si se eligió) fija la propina en transition()
        // y queda como pedido del cobro, para devolverlo en el banco. Con
        // bitcoin, la factura que se copió de BTCPay.
        await this.payments.transition(paymentId, {
          type: 'AUTHORIZED',
          provider: payment.provider,
          providerTxId: chargedOrder ?? payment.providerTxId,
        });
        // transition() ya puso authorizedAt. El código del banco solo se
        // apunta si no llegó antes con un aviso tardío (no se pisa).
        if (authCode) {
          await this.prisma.payment.updateMany({
            where: { id: paymentId, authCode: null },
            data: { authCode },
          });
        }
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
        ...(btcInvoice ? { btcpayInvoiceId: btcInvoice } : {}),
        fromStatus: payment.status,
      },
    });

    this.logger.warn(
      `Manual reconcile by ${user.sub}: payment=${paymentId} ${payment.status} → ${body.decision} auth=${authCode ?? '-'}${btcInvoice ? ` btcpay=${btcInvoice}` : ''} (reason: ${body.reason})`,
    );

    return { ok: true, newStatus: body.decision };
  }

  /**
   * Darlo por cobrado: con bitcoin (BTCPay), la factura de este cobro que casa
   * con lo que se copió de BTCPay (su id); con el banco, null, y hace falta su
   * código de autorización. Lo que no cuadra, 400 diciendo dónde mirarlo.
   */
  private async resolvedBitcoinInvoice(
    payment: { id: string; provider: string | null; providerTxId: string | null },
    body: { bankAuthCode?: string; btcpayInvoiceRef?: string },
  ): Promise<string | null> {
    if (payment.provider !== 'BTCPAY') {
      if (!body.bankAuthCode) throw new BadRequestException('Para marcarlo cobrado, pon el código de autorización del banco');
      return null;
    }
    if (!body.btcpayInvoiceRef) throw new BadRequestException(invoiceRefProblem('short'));
    const attempts = await this.prisma.asSystem((tx) =>
      tx.paymentAttempt.findMany({ where: { paymentId: payment.id, provider: 'BTCPAY' }, select: { providerTxId: true } }),
    );
    const match = matchInvoiceRef(body.btcpayInvoiceRef, [payment.providerTxId, ...attempts.map((a) => a.providerTxId)]);
    if (!match.ok) throw new BadRequestException(invoiceRefProblem(match.reason));
    return match.invoiceId;
  }

  /**
   * Fase 1B: cada intento puede llevar una propina distinta. Si no se sabe
   * qué pedido cobró el banco, no se puede saber qué propina le toca a la
   * chica: hay que elegirlo. Los intentos denegados no cuentan, y los cobros
   * sin intentos registrados (anteriores a la Fase 0) no se bloquean: su
   * único pedido es el del cobro (otro sería el cargo de otro cobro).
   */
  private async checkResolvedTip(
    paymentId: string,
    bankOrder: string | undefined,
    paymentOrder: string,
  ): Promise<void> {
    const attempts = await this.prisma.asSystem((tx) =>
      tx.paymentAttempt.findMany({
        where: { paymentId, status: { not: 'DENIED' } },
        select: { providerTxId: true, tipCents: true },
      }),
    );
    if (attempts.length === 0) {
      if (bankOrder && bankOrder !== paymentOrder) {
        throw new BadRequestException('Ese número de pedido no es de este cobro');
      }
      return;
    }
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
   * Kill-switch: revoca todas las sesiones de un usuario del propio venue.
   * Solo OWNER. Util cuando un manager pierde el movil — corta al momento sus
   * refresh tokens, sus tokens de acceso ya emitidos (AuthGuard) y sus
   * conexiones de tiempo real (RefreshTokenService.revokeAllForUser).
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
      tx.venue.findUniqueOrThrow({ where: { id: tenantId }, select: VENUE_SETTINGS_SELECT }),
    );
    return withEffectiveHoldDays(venue);
  }

  @Patch('venue/settings')
  @Roles('OWNER')
  async updateVenueSettings(
    @Tenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(VenueSettingsUpdateSchema)) dto: VenueSettingsUpdate,
  ) {
    const { platformCommissionBps, serviceFeeEnabled, serviceFeeBps, topUpServiceFeeBps, totpCode, ...rules } = dto;
    const feeSent = serviceFeeEnabled !== undefined || serviceFeeBps !== undefined || topUpServiceFeeBps !== undefined;
    if (Object.keys(rules).length === 0 && platformCommissionBps === undefined && !feeSent) {
      throw new NotFoundException('No hay campos a actualizar');
    }
    const { current, maxOverrideBps } = await this.prisma.asSystem(async (tx) => ({
      current: await tx.venue.findUniqueOrThrow({
        where: { id: tenantId },
        select: {
          operatorMaxCobroCents: true,
          platformCommissionBps: true,
          operatorCommissionDefaults: true,
          payoutHoldDays: true,
          refundApprovalThresholdCents: true,
          payoutRequiresApproval: true,
          serviceFeeEnabled: true,
          serviceFeeBps: true,
          topUpServiceFeeBps: true,
        },
      }),
      maxOverrideBps: (
        await tx.user.aggregate({
          where: { tenantId, role: 'OPERATOR', deletedAt: null, commissionBps: { not: null } },
          _max: { commissionBps: true },
        })
      )._max.commissionBps,
    }));
    if (platformCommissionBps !== undefined && platformCommissionBps !== current.platformCommissionBps) {
      throw new ForbiddenException(MSG_PLATFORM_COMMISSION_SA_ONLY);
    }
    const feeChanged =
      (serviceFeeEnabled !== undefined && serviceFeeEnabled !== current.serviceFeeEnabled) ||
      (serviceFeeBps !== undefined && serviceFeeBps !== current.serviceFeeBps) ||
      (topUpServiceFeeBps !== undefined && topUpServiceFeeBps !== current.topUpServiceFeeBps);
    if (feeChanged) throw new ForbiddenException(MSG_SERVICE_FEE_SA_ONLY);
    // Las comisiones llegan PARCIALES (se mezclan con las guardadas) y lo que
    // queda tiene que cuadrar como en la consola: chica + plataforma ≤ 100 %.
    const plan = planVenueRulesChange(current, rules, maxOverrideBps ?? null);
    if (!plan.ok) throw new BadRequestException(plan.problem);
    // Reglas de dinero (tope, comisiones, espera, aprobaciones): con la 2FA
    // activada hace falta el código (una sesión robada no basta).
    await this.totp.assertIfEnrolledForUser(user.sub, totpCode);

    const updated = await this.prisma.asSystem((tx) =>
      tx.venue.update({ where: { id: tenantId }, data: plan.change, select: VENUE_SETTINGS_SELECT }),
    );
    const before = Object.fromEntries(
      Object.keys(plan.change).map((k) => [k, current[k as keyof typeof current]]),
    );
    await this.audit.log({
      action: 'venue.settings.updated',
      tenantId,
      actorId: user.sub,
      actorEmail: user.email,
      targetType: 'Venue',
      targetId: tenantId,
      payload: { changes: rules, before },
    });
    return withEffectiveHoldDays(updated);
  }

  // ─── Operadoras (chicas) ──────────────────────────────────────────

  /** Las chicas con su saldo; `?role=WAITER`, los camareros (su parte de las invitaciones, que también se les paga). */
  @Get('operators')
  @Roles('OWNER', 'MANAGER')
  async listOperators(@Tenant() tenantId: string, @Query('role') role?: string) {
    if (role !== undefined && !isPayeeRole(role)) throw new BadRequestException('role: OPERATOR o WAITER');
    return this.operators.listVenueOperators(tenantId, role ?? 'OPERATOR');
  }

  @Post('operators')
  @Roles('OWNER', 'MANAGER')
  async createOperator(
    @Tenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(CreateOperatorSchema)) dto: CreateOperatorDto,
  ) {
    // Un encargado no fija la comisión: el servicio la ignora y avisa.
    return this.operators.createOperator(tenantId, user.sub, dto, user.role);
  }

  @Patch('operators/:id')
  @Roles('OWNER', 'MANAGER')
  async updateOperator(
    @Tenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(UpdateOperatorSchema)) dto: UpdateOperatorDto,
  ) {
    // Cambiar a dónde va el dinero de una chica es como pagarle: con 2FA si el
    // dueño la tiene (una sesión robada no basta). El encargado no puede (403
    // en el servicio) y el cambio queda en el registro con lo de antes.
    if (user.role === 'OWNER' && touchesPayoutAccount(dto)) {
      await this.totp.assertIfEnrolledForUser(user.sub, dto.totpCode);
    }
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
    // Con enlace de encargado la chica no puede poner su cuenta de cobro (solo el dueño).
    return this.operators.createSelfOnboardingLink(tenantId, id, user.sub, user.role);
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
   * El dueño lo hace directo. El encargado, si el local tiene
   * payoutRequiresApproval, no paga: lo pide al dueño y responde 202
   * `{ approvalRequestId, status: 'PENDING', … }` («Por aprobar»); si no, paga
   * él con 2FA obligatoria. Con una petición pendiente para la chica, nadie le
   * paga por otro lado (sus comisiones están reservadas).
   */
  @Post('operators/:id/payouts')
  @Roles('OWNER', 'MANAGER')
  @UseGuards(StaffPermissionGuard)
  @RequiresPermission('payouts')
  @HttpCode(201)
  async createOperatorPayout(
    @Tenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(CreatePayoutSchema)) dto: CreatePayoutDto,
    @Res({ passthrough: true }) reply?: FastifyReply,
    @OptionalIdempotencyKey() idempotencyKey?: string | null,
  ) {
    const actor = { userId: user.sub, role: user.role, tenantId };
    const route = await this.approvals.payoutRouteFor(actor);
    if (route.kind === 'forbidden') throw new ForbiddenException('Solo el dueño o el encargado pagan a las chicas');
    // La misma Idempotency-Key con la misma petición: el pago ya apuntado (o
    // la misma solicitud «Por aprobar») si se cortó la red o hubo doble clic,
    // sin pedir otra vez el 2FA ni pagar (o pedir) dos veces.
    const idempotency = idempotencyKey ? { key: idempotencyKey, hash: payoutRequestHash(user.sub, id, dto) } : undefined;
    if (route.kind === 'request') {
      reply?.status(202);
      return this.approvals.requestPayout(actor, id, dto, idempotency);
    }
    if (idempotency) {
      const replay = await this.operators.findPayoutReplay(tenantId, id, user.sub, idempotency);
      if (replay) return replay;
    }
    // Pagar a una chica mueve dinero: con 2FA activada, hace falta el código
    // (una sesión robada no basta para mandar su dinero a otra cuenta); el
    // encargado que paga directo, siempre. Intentos y códigos usados en
    // Redis: valen entre réplicas del API.
    if (route.twoFactor === 'required') await this.totp.assertForUser(user.sub, dto.totpCode, stepUpActions.operatorPayout(id));
    else await this.totp.assertIfEnrolledForUser(user.sub, dto.totpCode);
    return this.operators.createPayout(tenantId, id, user.sub, dto.notes, {
      externalTxId: dto.externalTxId,
      externalRail: dto.externalRail,
      receiptUrl: dto.receiptUrl,
      expectedTotalCents: dto.expectedTotalCents,
      idempotency,
      inTransaction: (tx) => assertNoPendingPayout(tx, tenantId, id),
    });
  }
}
