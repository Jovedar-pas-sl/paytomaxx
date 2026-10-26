import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { EmailService } from '../../common/email/email.service';
import { AuditService } from '../audit/audit.service';
import { RefreshTokenService } from '../auth/refresh-token.service';
import { PayoutVerifierFactory } from '../treasury/payout-verifier.factory';
import { isUniqueViolation, otherPayoutWithTx, txAlreadyUsed } from '../treasury/payout-tx-guard';
import { isAutoVerifiable } from '../treasury/verifiers/payout-verifier.interface';
import { operatorAppBaseUrl } from './operator-app-url';
import {
  replayPayout,
  type PayoutCreatedView,
  type PayoutIdempotency,
} from './payout-idempotency';
import { debtView, payoutAccountView, type DebtRow, type MyPayoutInfo } from './my-payout-info';
import { availableCentsOf, payoutCutoff, payoutTotalCents } from './payout-math';
import {
  exactSelection,
  lockOperatorPayouts,
  payableSelection,
  payoutChanged,
  payoutTotalChanged,
  settleSelection,
  type ExactPayout,
} from './payout-selection';
import { PAYEE_ROLES, type PayeeRole } from './payee-roles';
import { venueHoldDays } from './venue-hold-days';
import { payoutRoutingChanges, touchesPayoutAccount } from './payout-routing';
import { isRecordNotFound, selfOnboardingAlreadySaved, usedTokenMarker } from './self-onboarding-token';
import type {
  CreateOperatorDto,
  CreateOperatorResponse,
  OperatorBalance,
  OperatorPublicView,
  OperatorWithBalance,
  Role,
  EarningView,
  PayoutMethod,
  PayoutView,
  SelfOnboardingLinkResponse,
  SelfOnboardingProfile,
  SelfOnboardingSubmitDto,
  UpdateOperatorDto,
} from '@nightpay/contracts';
import { normalizeWireDetails } from '@nightpay/contracts';

const INVITE_TTL_HOURS = 24;
const SELF_ONBOARDING_TTL_HOURS = 72;
const COMMISSION_OWNER_ONLY_NOTICE =
  'La comisión la fija el dueño: a esta chica se le aplica la del local hasta que él la cambie.';

interface InviteJwtPayload {
  sub: string; // userId
  tenantId: string;
  purpose: 'operator-invite';
}

interface SelfOnboardingJwtPayload {
  sub: string; // operatorId
  tenantId: string;
  purpose: 'operator-self-onboarding';
  /** Enlace generado por el dueño: la chica puede poner su PRIMERA cuenta de cobro. */
  payout?: boolean;
}

/** Hash sha256 hex del token JWT. Persistimos el hash, no el token, en users.inviteToken. */
function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** El encargado no fija comisiones: la que mande se ignora (se aplica la del local). */
function commissionOnCreate(actorRole: Role, requested: number | undefined): { commissionBps: number | null; ignored: boolean } {
  if (actorRole === 'OWNER') return { commissionBps: requested ?? null, ignored: false };
  return { commissionBps: null, ignored: requested !== undefined };
}

/** Opciones de createPayout (referencia externa y lo de «Por aprobar»). */
export interface PayoutOptions {
  externalTxId?: string;
  externalRail?: string;
  receiptUrl?: string;
  /** Dentro de la transacción, con el candado de la chica, antes de leer sus comisiones. */
  inTransaction?: (tx: TransactionalClient) => Promise<void>;
  /** Pago aprobado: exactamente estas comisiones y deudas, por este total. */
  exact?: ExactPayout;
  /** La cifra que vio quien paga: si lo pagable ya es otro total, 409 PAYOUT_CHANGED. */
  expectedTotalCents?: number;
  /** Idempotency-Key de la petición: repetida, devuelve el mismo pago (payout-idempotency). */
  idempotency?: PayoutIdempotency;
  /** En la misma transacción, con el pago ya creado. */
  afterCreate?: (tx: TransactionalClient, payoutId: string) => Promise<void>;
  /** Para el registro. */
  approvalRequestId?: string;
}

function eur(cents: number): string {
  return `${(cents / 100).toFixed(2).replace('.', ',')} €`;
}

/** Ya tiene a dónde se le paga. */
function hasPayoutRouting(u: { payoutMethod?: string | null; payoutAddress?: string | null }): boolean {
  return Boolean(u.payoutMethod || u.payoutAddress);
}

@Injectable()
export class OperatorsService {
  private readonly logger = new Logger(OperatorsService.name);
  private readonly prisma: PrismaService;
  private readonly email: EmailService;
  private readonly audit: AuditService;
  private readonly config: ConfigService;
  private readonly jwt: JwtService;
  private readonly fxFactory: PayoutVerifierFactory;
  private readonly sessions: RefreshTokenService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(EmailService) email: EmailService,
    @Inject(AuditService) audit: AuditService,
    @Inject(ConfigService) config: ConfigService,
    @Inject(JwtService) jwt: JwtService,
    @Inject(PayoutVerifierFactory) fxFactory: PayoutVerifierFactory,
    @Inject(RefreshTokenService) sessions: RefreshTokenService,
  ) {
    this.prisma = prisma;
    this.email = email;
    this.audit = audit;
    this.config = config;
    this.jwt = jwt;
    this.fxFactory = fxFactory;
    this.sessions = sessions;
  }

  /**
   * La app de las chicas (enlaces de invitación y onboarding). Si no se sabe,
   * avisa ANTES de crear o cambiar nada.
   */
  private operatorAppUrl(): string {
    const url = operatorAppBaseUrl({
      operatorBaseUrl: this.config.get<string>('OPERATOR_BASE_URL'),
      operatorUrl: this.config.get<string>('NEXT_PUBLIC_OPERATOR_URL'),
      apiUrl: this.config.get<string>('NEXT_PUBLIC_API_URL'),
      production: this.config.get<string>('NODE_ENV') === 'production',
    });
    if (!url) throw new ServiceUnavailableException('Falta la dirección de la app de las chicas: configura OPERATOR_BASE_URL');
    return url;
  }

  /**
   * Rails cripto on-chain — usan FX snapshot al crear el payout.
   * Otros métodos (e-wallet, wire, LatAm, cash) son fiat directo, sin FX.
   */
  private static readonly CRYPTO_RAILS = new Set<string>([
    'USDT_TRC20',
    'USDT_BEP20',
    'USDC_POLY',
    'USDC_SOL',
    'BINANCE_PAY_ID',
    'OKX_INTERNAL',
    'BYBIT_INTERNAL',
  ]);

  // ─── Operator self-service (role=OPERATOR) ────────────────────────
  // Todas las funciones aceptan tenantId obligatorio + filtran la query raw
  // por AND "tenantId" para defensa cross-tenant (no depender solo de RLS o
  // del middleware CLS).

  async getBalance(operatorId: string, tenantId: string): Promise<OperatorBalance> {
    const cutoff = payoutCutoff(new Date(), await this.holdDays(tenantId));
    const rows = await this.prisma.withTenant(tenantId, (tx) => tx.$queryRaw<
      Array<{
        pendingCents: bigint;
        heldCents: bigint;
        paidCents: bigint;
        lifetimeGrossCents: bigint;
        count: bigint;
      }>
    >`
      SELECT
        COALESCE(SUM(CASE WHEN "payoutId" IS NULL THEN "commissionCents" + COALESCE("tipCents",0) - "reversedCents" ELSE 0 END), 0)::bigint AS "pendingCents",
        COALESCE(SUM(CASE WHEN "payoutId" IS NULL AND "createdAt" > ${cutoff} THEN "commissionCents" + COALESCE("tipCents",0) - "reversedCents" ELSE 0 END), 0)::bigint AS "heldCents",
        COALESCE(SUM(CASE WHEN "payoutId" IS NOT NULL THEN "commissionCents" + COALESCE("tipCents",0) - "reversedCents" ELSE 0 END), 0)::bigint AS "paidCents",
        COALESCE(SUM("paymentAmountCents"), 0)::bigint AS "lifetimeGrossCents",
        COUNT(*)::bigint AS count
      FROM operator_earnings
      WHERE "operatorId" = ${operatorId}::uuid
        AND "tenantId" = ${tenantId}::uuid
    `);
    const r = rows[0]!;
    const debtCents = await this.openDebtCents(operatorId, tenantId);
    const unpaid = Number(r.pendingCents);
    const held = Math.max(0, Number(r.heldCents));
    return {
      pendingCents: unpaid - debtCents,
      availableCents: availableCentsOf({ unpaidCents: unpaid, heldCents: held, debtCents }),
      heldCents: held,
      debtCents,
      paidCents: Math.max(0, Number(r.paidCents)),
      lifetimeGrossCents: Number(r.lifetimeGrossCents),
      count: Number(r.count),
    };
  }

  /** Los del local (regla del super-admin; 0 = al cierre de la noche) o PAYOUT_HOLD_DAYS. */
  private holdDays(tenantId: string): Promise<number> {
    return venueHoldDays(this.prisma, this.config.get('PAYOUT_HOLD_DAYS'), tenantId);
  }

  /** Devoluciones llegadas con la comisión ya pagada, aún sin descontar. */
  private async openDebtCents(operatorId: string, tenantId: string): Promise<number> {
    const rows = await this.prisma.withTenant(tenantId, (tx) => tx.$queryRaw<Array<{ total: bigint }>>`
      SELECT COALESCE(SUM(r."reversedDeltaCents"), 0)::bigint AS total
        FROM earning_reversals r
        JOIN operator_earnings e ON e.id = r."earningId"
       WHERE e."operatorId" = ${operatorId}::uuid
         AND e."tenantId" = ${tenantId}::uuid
         AND r."afterPayout"
         AND r."settledPayoutId" IS NULL
    `);
    return Number(rows[0]?.total ?? 0);
  }

  async getMyEarnings(
    operatorId: string,
    tenantId: string,
    limit = 50,
  ): Promise<EarningView[]> {
    const rows = await this.prisma.withTenant(tenantId, (tx) => tx.$queryRaw<
      Array<{
        id: string;
        paymentId: string | null;
        consumptionId: string | null;
        paymentAmountCents: number;
        commissionBps: number;
        commissionCents: number;
        tipCents: number;
        reversedCents: number;
        payoutId: string | null;
        paymentStatus: string | null;
        createdAt: Date;
      }>
    >`
      SELECT e.id, e."paymentId", e."consumptionId", e."paymentAmountCents", e."commissionBps",
             e."commissionCents", COALESCE(e."tipCents",0) AS "tipCents",
             e."reversedCents", e."payoutId",
             p.status::text AS "paymentStatus", e."createdAt"
        FROM operator_earnings e
        LEFT JOIN payments p ON p.id = e."paymentId"
       WHERE e."operatorId" = ${operatorId}::uuid
         AND e."tenantId" = ${tenantId}::uuid
       ORDER BY e."createdAt" DESC
       LIMIT ${limit}
    `);
    return rows.map((r) => ({
      id: r.id,
      paymentId: r.paymentId,
      paymentAmountCents: r.paymentAmountCents,
      commissionBps: r.commissionBps,
      commissionCents: r.commissionCents,
      tipCents: r.tipCents,
      reversedCents: r.reversedCents,
      netCents: r.commissionCents + r.tipCents - r.reversedCents,
      payoutId: r.payoutId,
      paymentStatus: r.paymentStatus,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async getMyPayments(operatorId: string, tenantId: string, limit = 50) {
    return this.prisma.payment.findMany({
      where: { createdByUserId: operatorId, tenantId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        amountCents: true,
        currency: true,
        status: true,
        provider: true,
        createdAt: true,
        qrToken: true,
        qrExpiresAt: true,
      },
    });
  }

  async getMyPayouts(
    operatorId: string,
    tenantId: string,
    limit = 50,
  ): Promise<PayoutView[]> {
    const rows = await this.prisma.withTenant(tenantId, (tx) => tx.$queryRaw<
      Array<{
        id: string;
        totalCents: number;
        paidByEmail: string | null;
        notes: string | null;
        earningCount: bigint;
        createdAt: Date;
        externalTxId: string | null;
        externalRail: string | null;
        reconciliationStatus: string;
        receiptUrl: string | null;
        reconciledAt: Date | null;
      }>
    >`
      SELECT po.id, po."totalCents", u.email AS "paidByEmail", po.notes,
             COALESCE(ec.cnt, 0)::bigint AS "earningCount",
             po."createdAt",
             po."externalTxId", po."externalRail", po."reconciliationStatus",
             po."receiptUrl", po."reconciledAt"
        FROM operator_payouts po
        LEFT JOIN users u ON u.id = po."paidByUserId"
        -- M3: JOIN agregado en lugar de subquery correlacionada por fila (N+1).
        LEFT JOIN (
          SELECT "payoutId", COUNT(*)::bigint AS cnt
            FROM operator_earnings
           WHERE "payoutId" IS NOT NULL
           GROUP BY "payoutId"
        ) ec ON ec."payoutId" = po.id
       WHERE po."operatorId" = ${operatorId}::uuid
         AND po."tenantId" = ${tenantId}::uuid
       ORDER BY po."createdAt" DESC
       LIMIT ${limit}
    `);
    return rows.map((r) => ({
      id: r.id,
      totalCents: r.totalCents,
      paidByEmail: r.paidByEmail,
      notes: r.notes,
      earningCount: Number(r.earningCount),
      createdAt: r.createdAt.toISOString(),
      externalTxId: r.externalTxId,
      externalRail: (r.externalRail as PayoutView['externalRail']) ?? null,
      reconciliationStatus: (r.reconciliationStatus as PayoutView['reconciliationStatus']),
      receiptUrl: r.receiptUrl,
      reconciledAt: r.reconciledAt?.toISOString() ?? null,
    }));
  }

  /**
   * «Ganancias» de la chica: días de espera antes de pagar, su cuenta de
   * cobro (enmascarada) y las devoluciones que llegaron con el cobro ya
   * pagado (abiertas primero: se descuentan del próximo pago).
   */
  async getMyPayoutInfo(operatorId: string, tenantId: string, limit = 30): Promise<MyPayoutInfo> {
    const [user, debts] = await Promise.all([
      this.prisma.user.findFirst({
        where: { id: operatorId, tenantId },
        select: { payoutMethod: true, payoutAddress: true, payoutLabel: true },
      }),
      this.prisma.asSystem((tx) => tx.$queryRaw<DebtRow[]>`
        SELECT r.id, e."paymentId", e."paymentAmountCents" AS "chargeCents",
               r."reversedDeltaCents" AS cents, r."createdAt" AS at, e."createdAt" AS "chargedAt",
               r."settledPayoutId", po."createdAt" AS "settledAt"
          FROM earning_reversals r
          JOIN operator_earnings e ON e.id = r."earningId"
          LEFT JOIN operator_payouts po ON po.id = r."settledPayoutId"
         WHERE e."operatorId" = ${operatorId}::uuid
           AND e."tenantId" = ${tenantId}::uuid
           AND r."afterPayout"
         ORDER BY (r."settledPayoutId" IS NULL) DESC, r."createdAt" DESC
         LIMIT ${limit}
      `),
    ]);
    return {
      holdDays: await this.holdDays(tenantId),
      account: payoutAccountView(user),
      debts: debts.map(debtView),
    };
  }

  // ─── Admin (OWNER/MANAGER del venue) ──────────────────────────────

  /** Las chicas del local (o los camareros: role WAITER) con su saldo. */
  async listVenueOperators(tenantId: string, role: PayeeRole = 'OPERATOR'): Promise<OperatorWithBalance[]> {
    const operators = await this.prisma.user.findMany({
      where: { tenantId, role, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    const result: OperatorWithBalance[] = [];
    for (const op of operators) {
      const balance = await this.getBalance(op.id, tenantId);
      result.push({
        ...this.toPublicView(op as never),
        balance,
      });
    }
    return result;
  }

  async createOperator(
    tenantId: string,
    actorUserId: string,
    dto: CreateOperatorDto,
    actorRole: Role,
  ): Promise<CreateOperatorResponse> {
    const email = dto.email.toLowerCase();
    const commission = commissionOnCreate(actorRole, dto.commissionBps);

    // Validar email único
    const existing = await this.prisma.asSystem((tx) =>
      tx.user.findUnique({ where: { email } }),
    );
    if (existing) {
      throw new ConflictException(`Email ${email} ya está registrado`);
    }
    // Antes de crear nada: sin la dirección de la app no hay enlace de invitación.
    const baseUrl = this.operatorAppUrl();

    // Pre-generamos el userId para poder firmar el JWT antes de persistir y mantener
    // todo el alta en una sola transacción atómica (insert user + JWT con su id +
    // update con el hash del token de invite). Si algo falla, rollback completo.
    const userId = randomUUID();
    // Hash placeholder de la columna NOT NULL. Cost 4 (mínimo) es intencional
    // porque este hash NUNCA se verifica con bcrypt.compare — al aceptar la
    // invitación se sobreescribe con un hash de cost 10. NO REUTILIZAR cost 4
    // para hashes que sí se verifican (el estándar del proyecto es 10).
    const placeholderHash = await bcrypt.hash(randomUUID(), 4);
    const inviteToken = await this.jwt.signAsync(
      { sub: userId, tenantId, purpose: 'operator-invite' } satisfies InviteJwtPayload,
      { expiresIn: `${INVITE_TTL_HOURS}h` },
    );
    const inviteTokenHash = hashInviteToken(inviteToken);

    const user = await this.prisma.$transaction(async (tx) => {
      return tx.user.create({
        data: {
          id: userId,
          tenantId,
          email,
          displayName: dto.displayName,
          passwordHash: placeholderHash,
          role: 'OPERATOR',
          commissionBps: commission.commissionBps,
          invitedAt: new Date(),
          inviteToken: inviteTokenHash,
        },
      });
    });

    const inviteUrl = `${baseUrl}/accept-invite?token=${inviteToken}`;

    // Intentar enviar email — si falla / NoOp, devolvemos URL al admin
    const venue = await this.prisma.venue.findUniqueOrThrow({
      where: { id: tenantId },
      select: { name: true },
    });
    const html = `
      <h2>Bienvenida a ${escapeHtml(venue.name)}</h2>
      <p>Hola ${escapeHtml(dto.displayName)},</p>
      <p>Has sido añadida como operadora. Activa tu cuenta y crea tu contraseña en este enlace
      (válido durante ${INVITE_TTL_HOURS} h):</p>
      <p><a href="${inviteUrl}">Activar cuenta</a></p>
      <p>Si tienes problemas, copia este link en tu navegador:<br/>${inviteUrl}</p>
    `;
    const sent = await this.email.send({
      to: email,
      subject: `Activa tu cuenta en ${venue.name}`,
      html,
      text: `Activa tu cuenta: ${inviteUrl}`,
    });

    await this.audit.log({
      action: 'operator.created',
      tenantId,
      actorId: actorUserId,
      targetType: 'User',
      targetId: user.id,
      payload: {
        email,
        displayName: dto.displayName,
        commissionBps: commission.commissionBps,
        commissionIgnored: commission.ignored,
        emailDelivered: sent.delivered,
      },
    });

    this.logger.log(
      `Operator created ${user.id} email=${email} venue=${tenantId} delivered=${sent.delivered}`,
    );

    return {
      operator: this.toPublicView(user),
      inviteUrl,
      emailSent: sent.delivered,
      ...(commission.ignored ? { notice: COMMISSION_OWNER_ONLY_NOTICE } : {}),
    };
  }

  async acceptInvite(token: string, password: string): Promise<{ ok: true }> {
    if (password.length < 8) {
      throw new BadRequestException('Password debe tener al menos 8 caracteres');
    }

    let decoded: InviteJwtPayload;
    try {
      decoded = await this.jwt.verifyAsync<InviteJwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }
    if (decoded.purpose !== 'operator-invite') {
      throw new UnauthorizedException('Token con propósito incorrecto');
    }

    const user = await this.prisma.asSystem((tx) =>
      tx.user.findUnique({
        where: { id: decoded.sub },
        select: { id: true, inviteToken: true, deletedAt: true },
      }),
    );
    if (!user || user.deletedAt) {
      throw new NotFoundException('Operadora no encontrada');
    }
    // Comparamos hash sha256 del token contra el guardado (no guardamos el token en claro).
    const tokenHash = hashInviteToken(token);
    if (!user.inviteToken || user.inviteToken !== tokenHash) {
      throw new UnauthorizedException('Token ya utilizado o caducado');
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await this.prisma.asSystem((tx) =>
      tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          invitedAt: null,
          inviteToken: null,
        },
      }),
    );

    await this.audit.log({
      action: 'operator.invite.accepted',
      tenantId: decoded.tenantId,
      actorId: user.id,
      targetType: 'User',
      targetId: user.id,
    });

    this.logger.log(`Operator invite accepted for user=${user.id}`);
    return { ok: true };
  }

  // ─── Admin password management ────────────────────────────────────
  //
  // Casos de uso:
  //   1. Chica perdió el invite link / nunca le llegó (email NoOp en prod)
  //      → admin regenera invite con TTL nuevo, copia URL, envía WhatsApp.
  //   2. Chica olvidó la contraseña ya activada
  //      → admin setea password directa O genera random, copia, envía WhatsApp.
  //      La chica debería cambiarla al loguear (TODO: forzar primer-login change).
  //
  // Resetear la contraseña cierra al momento todas sus sesiones (refresh y
  // tokens de acceso ya emitidos: RefreshTokenService.revokeAllForUser). Antes
  // los JWT seguían valiendo hasta caducar (1 h).

  /**
   * Genera un nuevo invite link para una operadora que aún no ha activado su
   * cuenta (o que la perdió). Rota el inviteToken anterior. TTL 24h.
   * Si la chica ya activó password (invitedAt=null), devuelve error — usar
   * resetPassword en su lugar.
   */
  async regenerateInvite(
    tenantId: string,
    operatorId: string,
    actorUserId: string,
  ): Promise<{ inviteUrl: string; expiresAt: string }> {
    const operator = await this.prisma.user.findFirst({
      where: { id: operatorId, tenantId, role: 'OPERATOR' },
      select: { id: true, email: true, deletedAt: true, invitedAt: true },
    });
    if (!operator) throw new NotFoundException('Operadora no encontrada');
    if (operator.deletedAt) throw new ConflictException('Operadora dada de baja');
    if (!operator.invitedAt) {
      throw new ConflictException(
        'Esta operadora ya activó su contraseña. Usa "Resetear contraseña" en su lugar.',
      );
    }
    const baseUrl = this.operatorAppUrl();

    const inviteToken = await this.jwt.signAsync(
      { sub: operator.id, tenantId, purpose: 'operator-invite' } satisfies InviteJwtPayload,
      { expiresIn: `${INVITE_TTL_HOURS}h` },
    );
    const inviteTokenHash = hashInviteToken(inviteToken);

    await this.prisma.user.update({
      where: { id: operator.id },
      data: {
        inviteToken: inviteTokenHash,
        invitedAt: new Date(),
      },
    });

    const inviteUrl = `${baseUrl}/accept-invite?token=${inviteToken}`;
    const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000);

    await this.audit.log({
      action: 'operator.invite.regenerated',
      tenantId,
      actorId: actorUserId,
      targetType: 'User',
      targetId: operator.id,
      payload: { ttlHours: INVITE_TTL_HOURS },
    });
    this.logger.log(`Invite regenerated for operator=${operator.id} by actor=${actorUserId}`);

    return { inviteUrl, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Resetea la contraseña de una operadora YA ACTIVADA. Admin pasa una
   * password explícita O nada (en cuyo caso se genera una random segura).
   * La password en claro SOLO se devuelve UNA vez en el response — admin
   * la copia y la envía por WhatsApp. NightPay no la persiste en claro.
   *
   * Si la chica todavía está en estado invite (invitedAt!=null), usar
   * regenerateInvite. Resetear pass directa sobre un usuario "pending"
   * cierra el flujo de invite — la chica nunca puso su propia password.
   */
  async resetPassword(
    tenantId: string,
    operatorId: string,
    actorUserId: string,
    explicitPassword: string | null,
  ): Promise<{ password: string; reset: true }> {
    const operator = await this.prisma.user.findFirst({
      where: { id: operatorId, tenantId, role: 'OPERATOR' },
      select: { id: true, email: true, deletedAt: true },
    });
    if (!operator) throw new NotFoundException('Operadora no encontrada');
    if (operator.deletedAt) throw new ConflictException('Operadora dada de baja');

    // Si admin pasa password explícita, validar; si no, generar random segura.
    let password: string;
    if (explicitPassword) {
      if (explicitPassword.length < 8) {
        throw new BadRequestException('Password mínimo 8 caracteres');
      }
      password = explicitPassword;
    } else {
      // 12 chars alfanuméricos legibles (sin 0/O/l/I que se confunden).
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
      const bytes = randomBytes(12);
      password = Array.from(bytes)
        .map((b) => alphabet[b % alphabet.length])
        .join('');
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await this.prisma.user.update({
      where: { id: operator.id },
      data: {
        passwordHash,
        // Si estaba pendiente de invite, cerramos ese flujo.
        invitedAt: null,
        inviteToken: null,
      },
    });
    // Con la contraseña vieja no se sigue dentro: ni el refresh ni el token de acceso.
    await this.sessions.revokeAllForUser(operator.id);

    await this.audit.log({
      action: 'operator.password.reset',
      tenantId,
      actorId: actorUserId,
      targetType: 'User',
      targetId: operator.id,
      payload: { explicit: Boolean(explicitPassword) },
    });
    this.logger.log(
      `Password reset for operator=${operator.id} by actor=${actorUserId} explicit=${Boolean(explicitPassword)}`,
    );

    return { password, reset: true };
  }

  // ─── Self-onboarding (Phase 1A.2) ────────────────────────────────
  // Admin genera un link único 72h. Chica abre el link sin login → ve form
  // pre-rellenado con sus datos actuales → submite. Si no sabe manejar la
  // web, el admin sigue rellenando desde su tab Onboarding como hasta ahora.

  /**
   * Genera (o regenera) el link self-onboarding para una operadora.
   * Solo OWNER/MANAGER del venue. El JWT anterior queda inválido al rotar.
   */
  async createSelfOnboardingLink(
    tenantId: string,
    operatorId: string,
    actorUserId: string,
    actorRole: Role,
  ): Promise<SelfOnboardingLinkResponse> {
    // Solo con enlace del dueño puede la chica poner su primera cuenta de cobro:
    // un encargado no decide a dónde va su dinero (como en el PATCH).
    const payout = actorRole === 'OWNER';
    const operator = await this.prisma.user.findFirst({
      where: { id: operatorId, tenantId, role: 'OPERATOR' },
      select: { id: true, email: true, deletedAt: true },
    });
    if (!operator) throw new NotFoundException('Operadora no encontrada');
    if (operator.deletedAt) throw new ConflictException('Operadora dada de baja');
    const baseUrl = this.operatorAppUrl();

    const token = await this.jwt.signAsync(
      {
        sub: operator.id,
        tenantId,
        purpose: 'operator-self-onboarding',
        payout,
      } satisfies SelfOnboardingJwtPayload,
      { expiresIn: `${SELF_ONBOARDING_TTL_HOURS}h` },
    );
    const tokenHash = hashInviteToken(token);

    await this.prisma.user.update({
      where: { id: operator.id },
      data: { selfOnboardingToken: tokenHash },
    });

    const url = `${baseUrl}/onboarding/${token}`;
    const expiresAt = new Date(Date.now() + SELF_ONBOARDING_TTL_HOURS * 60 * 60 * 1000);

    await this.audit.log({
      action: 'operator.self_onboarding_link.created',
      tenantId,
      actorId: actorUserId,
      targetType: 'User',
      targetId: operator.id,
      payload: { ttlHours: SELF_ONBOARDING_TTL_HOURS, payoutAllowed: payout },
    });
    this.logger.log(
      `Self-onboarding link created for operator=${operator.id} by actor=${actorUserId}`,
    );

    return { url, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Validación + lectura del perfil actual para que la chica vea sus datos
   * pre-rellenados en el form. Sin auth — el token JWT es la cred.
   */
  async getSelfOnboardingProfile(token: string): Promise<SelfOnboardingProfile> {
    const { operator, payoutAllowed } = await this.validateSelfOnboardingToken(token);
    const venue = await this.prisma.asSystem((tx) =>
      tx.venue.findUniqueOrThrow({
        where: { id: operator.tenantId },
        select: { name: true },
      }),
    );
    const u = operator as unknown as {
      email: string;
      displayName: string | null;
      phone: string | null;
      passportCountry: string | null;
      passportLast4: string | null;
      hasEmpadronamiento: boolean;
      hasNie: boolean;
      hasTie: boolean;
      walletProvider: string | null;
      walletStatus: string | null;
      walletTestPassed: boolean;
      needsHelpWallet: boolean;
      needsHelpDocs: boolean;
      onboardingNotes: string | null;
      payoutMethod: string | null;
      payoutAddress: string | null;
      payoutLabel: string | null;
    };
    return {
      displayName: u.displayName,
      email: u.email,
      phone: u.phone,
      passportCountry: u.passportCountry,
      passportLast4: u.passportLast4,
      hasEmpadronamiento: u.hasEmpadronamiento ?? false,
      hasNie: u.hasNie ?? false,
      hasTie: u.hasTie ?? false,
      walletProvider: u.walletProvider as SelfOnboardingProfile['walletProvider'],
      walletStatus: u.walletStatus as SelfOnboardingProfile['walletStatus'],
      walletTestPassed: u.walletTestPassed ?? false,
      needsHelpWallet: u.needsHelpWallet ?? false,
      needsHelpDocs: u.needsHelpDocs ?? false,
      onboardingNotes: u.onboardingNotes,
      payoutMethod: u.payoutMethod as SelfOnboardingProfile['payoutMethod'],
      payoutAddress: u.payoutAddress,
      payoutLabel: u.payoutLabel,
      venueName: venue.name,
      canSetPayout: payoutAllowed && !hasPayoutRouting(u),
    };
  }

  /**
   * La chica submite su form. Validamos token, actualizamos datos, e
   * INVALIDAMOS el token (single-use). Si la chica necesita editar más tarde,
   * el admin regenera un link nuevo.
   *
   * Antes el token quedaba activo 72h reutilizable — vector: link interceptado
   * permitía a un atacante cambiar payoutAddress hasta 72h. Ahora single-use.
   * El token usado queda marcado (self-onboarding-token.ts): el mismo enlace
   * otra vez da 409 «ya se guardaron tus datos», no «Token inválido».
   */
  async submitSelfOnboarding(
    token: string,
    dto: SelfOnboardingSubmitDto,
  ): Promise<{ ok: true; payoutIgnored?: 'existing' | 'owner_required' }> {
    const { operator, payoutAllowed, decoded, tokenHash } = await this.validateSelfOnboardingToken(token);

    const data: Record<string, unknown> = {};
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.passportCountry !== undefined) data.passportCountry = dto.passportCountry;
    if (dto.passportLast4 !== undefined) data.passportLast4 = dto.passportLast4;
    if (dto.hasEmpadronamiento !== undefined) data.hasEmpadronamiento = dto.hasEmpadronamiento;
    if (dto.hasNie !== undefined) data.hasNie = dto.hasNie;
    if (dto.hasTie !== undefined) data.hasTie = dto.hasTie;
    if (dto.walletProvider !== undefined) data.walletProvider = dto.walletProvider;
    if (dto.walletStatus !== undefined) data.walletStatus = dto.walletStatus;
    if (dto.walletTestPassed !== undefined) {
      data.walletTestPassed = dto.walletTestPassed;
      data.walletTestAt = dto.walletTestPassed ? new Date() : null;
    }
    if (dto.needsHelpWallet !== undefined) data.needsHelpWallet = dto.needsHelpWallet;
    if (dto.needsHelpDocs !== undefined) data.needsHelpDocs = dto.needsHelpDocs;
    if (dto.onboardingNotes !== undefined) data.onboardingNotes = dto.onboardingNotes;
    // A dónde va su dinero: solo la primera vez y solo con enlace del dueño.
    // Si ya tiene cuenta, o el enlace lo generó un encargado, no se toca: queda
    // como propuesta en el registro y la pone el dueño desde el panel.
    const existing = operator as unknown as { payoutMethod?: string | null; payoutAddress?: string | null };
    const wantsPayout =
      dto.payoutMethod !== undefined || dto.payoutAddress !== undefined || dto.payoutLabel !== undefined;
    const payoutIgnored = !wantsPayout
      ? undefined
      : hasPayoutRouting(existing)
        ? ('existing' as const)
        : payoutAllowed
          ? undefined
          : ('owner_required' as const);
    if (payoutIgnored) {
      this.logger.warn(`Self-onboarding ${(operator as { id: string }).id}: cuenta de cobro no aplicada (${payoutIgnored})`);
    } else {
      Object.assign(data, payoutRoutingChanges(existing, dto));
      if (dto.payoutLabel !== undefined) data.payoutLabel = dto.payoutLabel;
      // Transferencia internacional: los datos del banco (los otros métodos no llevan).
      const wire = dto.payoutMethod === 'WIRE_INTERNATIONAL' ? normalizeWireDetails(dto.payoutMetadata) : null;
      if (wire) data.payoutMetadata = wire;
    }

    // Marca progreso de onboarding automáticamente si todavía está NEW
    const current = operator as unknown as { onboardingStatus: string | null };
    if (current.onboardingStatus === 'NEW' || current.onboardingStatus === 'PROFILE_CREATED') {
      data.onboardingStatus = 'INVITE_ACTIVATED';
    }

    // Un solo uso: el enlace queda «usado» (ya no deja guardar ni leer; un
    // reintento con la respuesta perdida sabe que ya se guardó). La chica pide
    // al admin un enlace nuevo si quiere volver a editar. Solo si sigue siendo
    // el activo: dos «Guardar» a la vez no guardan dos veces.
    data.selfOnboardingToken = usedTokenMarker(tokenHash);

    // Ruta pública (sin local en el contexto): como la lectura del token, con asSystem.
    try {
      await this.prisma.asSystem((tx) =>
        tx.user.update({ where: { id: operator.id, selfOnboardingToken: tokenHash }, data }),
      );
    } catch (err) {
      if (isRecordNotFound(err)) throw await this.goneSelfOnboardingToken(decoded, tokenHash);
      throw err;
    }

    await this.audit.log({
      action: 'operator.self_onboarding.submitted',
      tenantId: operator.tenantId,
      actorId: operator.id, // la propia chica es el actor
      targetType: 'User',
      targetId: operator.id,
      payload: {
        fields: Object.keys(data),
        tokenInvalidated: true,
        ...(payoutIgnored
          ? {
              payoutIgnored,
              proposedPayout: {
                method: dto.payoutMethod ?? null,
                address: dto.payoutAddress ?? null,
                label: dto.payoutLabel ?? null,
                ...(dto.payoutMetadata ? { metadata: dto.payoutMetadata } : {}),
              },
            }
          : {}),
      },
    });

    this.logger.log(`Self-onboarding submitted by operator=${operator.id} (token invalidated)`);
    return payoutIgnored ? { ok: true, payoutIgnored } : { ok: true };
  }

  /**
   * Valida el JWT + hash en DB. Devuelve el row del operator si OK.
   * Throws UnauthorizedException en cualquier fallo de validación — sin
   * detalles del motivo para no filtrar info a un atacante.
   */
  private async validateSelfOnboardingToken(token: string) {
    let decoded: SelfOnboardingJwtPayload;
    try {
      decoded = await this.jwt.verifyAsync<SelfOnboardingJwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }
    if (decoded.purpose !== 'operator-self-onboarding') {
      throw new UnauthorizedException('Token inválido');
    }
    const tokenHash = hashInviteToken(token);
    const operator = await this.prisma.asSystem((tx) =>
      tx.user.findFirst({
        where: {
          id: decoded.sub,
          tenantId: decoded.tenantId,
          role: 'OPERATOR',
          selfOnboardingToken: tokenHash,
          deletedAt: null,
        },
      }),
    );
    if (!operator) throw await this.goneSelfOnboardingToken(decoded, tokenHash);
    // Enlaces de antes (sin el dato) cuentan como de encargado.
    return { operator, payoutAllowed: decoded.payout === true, decoded, tokenHash };
  }

  /**
   * El enlace (bien firmado y sin caducar) ya no es el activo: si se usó para
   * guardar, 409 «ya se guardaron tus datos»; si no (el admin hizo otro), 401.
   */
  private async goneSelfOnboardingToken(decoded: SelfOnboardingJwtPayload, tokenHash: string): Promise<Error> {
    const used = await this.prisma.asSystem((tx) =>
      tx.user.findFirst({
        where: {
          id: decoded.sub,
          tenantId: decoded.tenantId,
          role: 'OPERATOR',
          selfOnboardingToken: usedTokenMarker(tokenHash),
          deletedAt: null,
        },
        select: { id: true },
      }),
    );
    return used ? selfOnboardingAlreadySaved() : new UnauthorizedException('Token inválido o ya rotado');
  }

  /**
   * Campos que solo OWNER puede modificar — son de impacto financiero o legal:
   * - commissionBps: cambia el % que se lleva la chica de cada cobro
   * - active: dar de baja una chica
   * - payoutMethod/Address/Metadata/Label: a dónde va su dinero
   *
   * MANAGER puede tocar el resto (datos personales, onboarding, ayuda) que es
   * info operativa sin riesgo monetario directo.
   */
  private static readonly OWNER_ONLY_FIELDS = new Set<keyof UpdateOperatorDto>([
    'commissionBps',
    'active',
    'payoutMethod',
    'payoutAddress',
    'payoutMetadata',
    'payoutLabel',
  ]);

  async updateOperator(
    tenantId: string,
    operatorId: string,
    actorUserId: string,
    actorRole: 'OWNER' | 'MANAGER' | 'WAITER' | 'OPERATOR',
    dto: UpdateOperatorDto,
  ): Promise<OperatorPublicView> {
    const operator = await this.prisma.user.findFirst({
      where: { id: operatorId, tenantId, role: 'OPERATOR' },
    });
    if (!operator) throw new NotFoundException('Operadora no encontrada');

    if (actorRole !== 'OWNER') {
      const attemptedOwnerFields = (Object.keys(dto) as Array<keyof UpdateOperatorDto>).filter(
        (k) => OperatorsService.OWNER_ONLY_FIELDS.has(k) && dto[k] !== undefined,
      );
      if (attemptedOwnerFields.length > 0) {
        throw new ForbiddenException(
          `Solo OWNER puede modificar: ${attemptedOwnerFields.join(', ')}`,
        );
      }
    }

    const data: Record<string, unknown> = {};
    if (dto.displayName !== undefined) data.displayName = dto.displayName;
    if (dto.commissionBps !== undefined) data.commissionBps = dto.commissionBps;
    if (dto.active !== undefined) {
      data.deletedAt = dto.active ? null : new Date();
    }
    // Phase 1A — payout routing (la dirección tiene que ser del método que queda)
    Object.assign(data, payoutRoutingChanges(operator as { payoutMethod?: string | null; payoutAddress?: string | null }, dto));
    if (dto.payoutMetadata !== undefined) data.payoutMetadata = dto.payoutMetadata;
    if (dto.payoutLabel !== undefined) data.payoutLabel = dto.payoutLabel;
    // Phase 1A.1 — Onboarding tracking
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.passportCountry !== undefined) data.passportCountry = dto.passportCountry;
    if (dto.passportLast4 !== undefined) data.passportLast4 = dto.passportLast4;
    if (dto.hasEmpadronamiento !== undefined) data.hasEmpadronamiento = dto.hasEmpadronamiento;
    if (dto.hasNie !== undefined) data.hasNie = dto.hasNie;
    if (dto.hasTie !== undefined) data.hasTie = dto.hasTie;
    if (dto.walletProvider !== undefined) data.walletProvider = dto.walletProvider;
    if (dto.walletStatus !== undefined) data.walletStatus = dto.walletStatus;
    if (dto.walletTestPassed !== undefined) {
      data.walletTestPassed = dto.walletTestPassed;
      data.walletTestAt = dto.walletTestPassed ? new Date() : null;
    }
    if (dto.needsHelpWallet !== undefined) data.needsHelpWallet = dto.needsHelpWallet;
    if (dto.needsHelpDocs !== undefined) data.needsHelpDocs = dto.needsHelpDocs;
    if (dto.onboardingStatus !== undefined) data.onboardingStatus = dto.onboardingStatus;
    if (dto.onboardingNotes !== undefined) data.onboardingNotes = dto.onboardingNotes;

    const updated = await this.prisma.user.update({
      where: { id: operatorId },
      data,
    });
    // Baja: fuera al momento de la app (refresh y tokens de acceso ya emitidos).
    if (dto.active === false) await this.sessions.revokeAllForUser(operatorId);

    const { totpCode: _code, ...changes } = dto;
    await this.audit.log({
      action: 'operator.updated',
      tenantId,
      actorId: actorUserId,
      targetType: 'User',
      targetId: operatorId,
      payload: { changes },
    });
    // A dónde va su dinero: con lo de antes (para saber a qué cuenta se pagaba).
    if (touchesPayoutAccount(dto)) {
      await this.audit.log({
        action: 'operator.payout_account_changed',
        tenantId,
        actorId: actorUserId,
        targetType: 'User',
        targetId: operatorId,
        payload: { before: payoutAccountOf(operator), after: payoutAccountOf(updated) },
      });
    }

    return this.toPublicView(updated);
  }

  async listOperatorEarnings(
    tenantId: string,
    operatorId: string,
    limit = 100,
  ): Promise<EarningView[]> {
    // Verificar que la operadora (o el camarero) pertenece a este venue (anti-IDOR)
    const exists = await this.prisma.user.findFirst({
      where: { id: operatorId, tenantId, role: { in: [...PAYEE_ROLES] } },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Operadora no encontrada');
    return this.getMyEarnings(operatorId, tenantId, limit);
  }

  async listOperatorPayouts(
    tenantId: string,
    operatorId: string,
    limit = 100,
  ): Promise<PayoutView[]> {
    const exists = await this.prisma.user.findFirst({
      where: { id: operatorId, tenantId, role: { in: [...PAYEE_ROLES] } },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Operadora no encontrada');
    return this.getMyPayouts(operatorId, tenantId, limit);
  }

  /**
   * Marca un payout para una operadora — agrupa todos los earnings sin
   * payoutId actual y los liquida atómicamente.
   * Si el neto agregado es <= 0 (ej. solo deudas pendientes) → 409.
   *
   * «Por aprobar»: con `exact` se pagan exactamente las comisiones y deudas que
   * fijó la petición y por ese total; si algo cambió (ya pagadas, devoluciones
   * nuevas…), 409 y no se apunta nada. `inTransaction` corre dentro de la
   * transacción, con el candado de la chica tomado y antes de leer nada (la
   * aprobación se marca ahí; el pago directo comprueba que no haya una
   * petición pendiente); `afterCreate`, en la misma transacción, con el pago.
   * `expectedTotalCents`: si lo pagable ya no es lo que vio quien paga, 409
   * PAYOUT_CHANGED. `idempotency`: la misma clave y petición devuelven el pago
   * ya apuntado (comprobado con el candado de la chica tomado).
   */
  async createPayout(
    tenantId: string,
    operatorId: string,
    paidByUserId: string,
    notes?: string,
    options?: PayoutOptions,
  ) {
    // Verificar pertenencia + leer payoutMethod por defecto (chica o camarero)
    const operator = await this.prisma.user.findFirst({
      where: { id: operatorId, tenantId, role: { in: [...PAYEE_ROLES] } },
    }) as unknown as { id: string; payoutMethod: string | null } | null;
    if (!operator) throw new NotFoundException('Operadora no encontrada');
    const holdDays = await this.holdDays(tenantId);
    // Rail efectivo: el del dto si viene, sino el preferido de la chica.
    const rail = options?.externalRail ?? operator.payoutMethod ?? null;

    const result = await this.prisma.withTenant(tenantId, async (tx) => {
      await lockOperatorPayouts(tx, operatorId);
      const idempotency = options?.idempotency;
      if (idempotency) {
        const replay = await replayPayout(tx, { tenantId, operatorId, paidByUserId, idempotency });
        if (replay) return { replay };
      }
      await options?.inTransaction?.(tx);
      // Un hash on-chain solo vale para un pago del local.
      const txId = options?.externalTxId?.trim();
      if (txId && isAutoVerifiable(rail as PayoutMethod | null)) {
        const other = await otherPayoutWithTx(tx, tenantId, null, txId);
        if (other) throw txAlreadyUsed(other);
      }

      const { pending, debts } = options?.exact
        ? await exactSelection(tx, tenantId, operatorId, options.exact)
        : await payableSelection(tx, tenantId, operatorId, holdDays);
      const totalCents = payoutTotalCents(pending, debts);
      if (totalCents <= 0) {
        throw new ConflictException(
          `Saldo neto ${totalCents / 100} € — no hay nada que liquidar (la operadora arrastra deuda por devoluciones).`,
        );
      }
      if (options?.exact && totalCents !== options.exact.totalCents) {
        throw payoutChanged(`El saldo de la chica ha cambiado desde que se pidió (ahora ${eur(totalCents)}).`);
      }
      if (options?.expectedTotalCents !== undefined && totalCents !== options.expectedTotalCents) {
        throw payoutTotalChanged(totalCents, options.expectedTotalCents);
      }

      const payoutData = await this.payoutData({ tenantId, operatorId, totalCents, paidByUserId, notes, rail, options });
      const payout = await tx.operatorPayout.create({ data: payoutData as never });
      await settleSelection(tx, payout.id, pending, debts);
      await options?.afterCreate?.(tx, payout.id);
      return { payout, count: pending.length };
    }).catch(async (err: unknown) => {
      if (!isUniqueViolation(err)) throw err;
      // Choque de único: Prisma no siempre dice qué índice fue (con FORCE RLS
      // Postgres esconde el detalle y llega «(not available)»). Se vuelve a
      // buscar la clave: el mismo pago → se devuelve; de otra chica, persona o
      // petición → 409 IDEMPOTENCY_KEY_REUSED (lo lanza replayPayout).
      const raced = options?.idempotency
        ? await this.findPayoutReplay(tenantId, operatorId, paidByUserId, options.idempotency)
        : null;
      if (raced) return { replay: raced };
      // Si no era la clave: otro pago se quedó el mismo hash (índice único parcial).
      throw txAlreadyUsed();
    });
    if ('replay' in result && result.replay) {
      this.logger.log(`Payout ${result.replay.id} repetido con la misma Idempotency-Key: no se apunta otra vez`);
      return result.replay;
    }

    await this.audit.log({
      action: 'operator.payout.created',
      tenantId,
      actorId: paidByUserId,
      targetType: 'User',
      targetId: operatorId,
      payload: {
        payoutId: result.payout.id,
        totalCents: result.payout.totalCents,
        earningCount: result.count,
        notes,
        ...(options?.approvalRequestId ? { approvalRequestId: options.approvalRequestId } : {}),
      },
    });

    this.logger.log(
      `Payout ${result.payout.id} created operator=${operatorId} total=${result.payout.totalCents}c earnings=${result.count}`,
    );

    return {
      id: result.payout.id,
      totalCents: result.payout.totalCents,
      earningCount: result.count,
      createdAt: result.payout.createdAt.toISOString(),
    };
  }

  /**
   * El pago ya apuntado con esta Idempotency-Key por esta persona y para esta
   * chica (null si no hay; 409 si la clave es de otra petición). El controlador
   * lo mira antes de pedir el 2FA: repetir la petición no vuelve a pedirlo.
   */
  async findPayoutReplay(
    tenantId: string,
    operatorId: string,
    paidByUserId: string,
    idempotency: PayoutIdempotency,
  ): Promise<PayoutCreatedView | null> {
    return this.prisma.withTenant(tenantId, (tx) => replayPayout(tx, { tenantId, operatorId, paidByUserId, idempotency }));
  }

  /**
   * Datos del pago. Rail cripto → FX snapshot (Track sprint 2026-05-13 #15):
   * congelamos la tasa EUR↔USDT al crearlo; el verifier on-chain usará este
   * snapshot, no la tasa actual — evita falsos MISMATCH por volatilidad.
   */
  private async payoutData(input: {
    tenantId: string;
    operatorId: string;
    totalCents: number;
    paidByUserId: string;
    notes: string | undefined;
    rail: string | null;
    options: PayoutOptions | undefined;
  }): Promise<Record<string, unknown>> {
    const { tenantId, operatorId, totalCents, paidByUserId, notes, rail, options } = input;
    const data: Record<string, unknown> = { tenantId, operatorId, totalCents, paidByUserId, notes };
    if (options?.idempotency) {
      data.idempotencyKey = options.idempotency.key;
      data.idempotencyHash = options.idempotency.hash;
    }
    if (options?.externalTxId) data.externalTxId = options.externalTxId;
    if (rail) data.externalRail = rail;
    if (options?.receiptUrl) data.receiptUrl = options.receiptUrl;
    if (!rail || !OperatorsService.CRYPTO_RAILS.has(rail)) return data;
    try {
      const fx = await this.fxFactory.getEurToUsdtRateInfo();
      data.payoutFxRate = fx.rate.toFixed(6);
      data.expectedAmountUsdt = ((totalCents / 100) * fx.rate).toFixed(6);
      if (fx.degraded) {
        this.logger.warn(
          `Payout FX snapshot tomado en modo degraded (Binance API down) — payout=${operatorId} rate=${fx.rate} usando fallback`,
        );
      }
    } catch (err) {
      // Si falla el FX lookup, dejamos el payout sin snapshot (legacy mode)
      this.logger.error(
        `FX snapshot failed for operator=${operatorId}: ${(err as Error).message}. Payout creado sin snapshot.`,
      );
    }
    return data;
  }

  async ensureBelongsToVenue(operatorId: string, tenantId: string): Promise<void> {
    const exists = await this.prisma.user.findFirst({
      where: { id: operatorId, tenantId, role: { in: [...PAYEE_ROLES] } },
      select: { id: true },
    });
    if (!exists) throw new ForbiddenException('Operadora no pertenece a tu venue');
  }

  private toPublicView(user: {
    id: string;
    email: string;
    displayName: string | null;
    commissionBps: number | null;
    deletedAt: Date | null;
    invitedAt: Date | null;
    createdAt: Date;
  }): OperatorPublicView {
    const u = user as unknown as {
      id: string;
      email: string;
      displayName: string | null;
      commissionBps: number | null;
      deletedAt: Date | null;
      invitedAt: Date | null;
      createdAt: Date;
      payoutMethod?: string | null;
      payoutAddress?: string | null;
      payoutMetadata?: Record<string, unknown> | null;
      payoutLabel?: string | null;
      phone?: string | null;
      passportCountry?: string | null;
      passportLast4?: string | null;
      hasEmpadronamiento?: boolean;
      hasNie?: boolean;
      hasTie?: boolean;
      walletProvider?: string | null;
      walletStatus?: string | null;
      walletTestPassed?: boolean;
      walletTestAt?: Date | null;
      needsHelpWallet?: boolean;
      needsHelpDocs?: boolean;
      onboardingStatus?: string;
      onboardingNotes?: string | null;
    };
    return {
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      commissionBps: u.commissionBps ?? 0,
      active: u.deletedAt === null,
      invitedAt: u.invitedAt?.toISOString() ?? null,
      createdAt: u.createdAt.toISOString(),
      payoutMethod: (u.payoutMethod ?? null) as OperatorPublicView['payoutMethod'],
      payoutAddress: u.payoutAddress ?? null,
      payoutMetadata: (u.payoutMetadata ?? null) as OperatorPublicView['payoutMetadata'],
      payoutLabel: u.payoutLabel ?? null,
      phone: u.phone ?? null,
      passportCountry: u.passportCountry ?? null,
      passportLast4: u.passportLast4 ?? null,
      hasEmpadronamiento: u.hasEmpadronamiento ?? false,
      hasNie: u.hasNie ?? false,
      hasTie: u.hasTie ?? false,
      walletProvider: (u.walletProvider ?? null) as OperatorPublicView['walletProvider'],
      walletStatus: (u.walletStatus ?? null) as OperatorPublicView['walletStatus'],
      walletTestPassed: u.walletTestPassed ?? false,
      walletTestAt: u.walletTestAt?.toISOString() ?? null,
      needsHelpWallet: u.needsHelpWallet ?? false,
      needsHelpDocs: u.needsHelpDocs ?? false,
      onboardingStatus: (u.onboardingStatus ?? 'NEW') as OperatorPublicView['onboardingStatus'],
      onboardingNotes: u.onboardingNotes ?? null,
    };
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** La cuenta de cobro de una chica, para el registro (operator.payout_account_changed). */
function payoutAccountOf(u: {
  payoutMethod?: string | null;
  payoutAddress?: string | null;
  payoutLabel?: string | null;
}): { payoutMethod: string | null; payoutAddress: string | null; payoutLabel: string | null } {
  return { payoutMethod: u.payoutMethod ?? null, payoutAddress: u.payoutAddress ?? null, payoutLabel: u.payoutLabel ?? null };
}
