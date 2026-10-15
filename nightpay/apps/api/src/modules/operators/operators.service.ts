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
import { PrismaService } from '../../common/prisma/prisma.service';
import { EmailService } from '../../common/email/email.service';
import { AuditService } from '../audit/audit.service';
import { PayoutVerifierFactory } from '../treasury/payout-verifier.factory';
import { isUniqueViolation, otherPayoutWithTx, txAlreadyUsed } from '../treasury/payout-tx-guard';
import { isAutoVerifiable } from '../treasury/verifiers/payout-verifier.interface';
import { operatorAppBaseUrl } from './operator-app-url';
import { availableCentsOf, parseHoldDays, payoutCutoff, payoutTotalCents } from './payout-math';
import { payoutRoutingChanges } from './payout-routing';
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

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(EmailService) email: EmailService,
    @Inject(AuditService) audit: AuditService,
    @Inject(ConfigService) config: ConfigService,
    @Inject(JwtService) jwt: JwtService,
    @Inject(PayoutVerifierFactory) fxFactory: PayoutVerifierFactory,
  ) {
    this.prisma = prisma;
    this.email = email;
    this.audit = audit;
    this.config = config;
    this.jwt = jwt;
    this.fxFactory = fxFactory;
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
    const cutoff = payoutCutoff(new Date(), this.holdDays());
    const rows = await this.prisma.$queryRaw<
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
    `;
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

  private holdDays(): number {
    return parseHoldDays(this.config.get('PAYOUT_HOLD_DAYS'));
  }

  /** Devoluciones llegadas con la comisión ya pagada, aún sin descontar. */
  private async openDebtCents(operatorId: string, tenantId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ total: bigint }>>`
      SELECT COALESCE(SUM(r."reversedDeltaCents"), 0)::bigint AS total
        FROM earning_reversals r
        JOIN operator_earnings e ON e.id = r."earningId"
       WHERE e."operatorId" = ${operatorId}::uuid
         AND e."tenantId" = ${tenantId}::uuid
         AND r."afterPayout"
         AND r."settledPayoutId" IS NULL
    `;
    return Number(rows[0]?.total ?? 0);
  }

  async getMyEarnings(
    operatorId: string,
    tenantId: string,
    limit = 50,
  ): Promise<EarningView[]> {
    const rows = await this.prisma.$queryRaw<
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
    `;
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
    const rows = await this.prisma.$queryRaw<
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
    `;
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

  // ─── Admin (OWNER/MANAGER del venue) ──────────────────────────────

  async listVenueOperators(tenantId: string): Promise<OperatorWithBalance[]> {
    const operators = await this.prisma.user.findMany({
      where: { tenantId, role: 'OPERATOR', deletedAt: null },
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
  // Ambos endpoints invalidan todas las sesiones activas de la chica (no las
  // implementamos aquí — la rotación del passwordHash basta para que los JWT
  // existentes sigan siendo válidos hasta su expiración; el refresh tokens
  // se revocan via /admin/users/:userId/revoke-sessions si hace falta).

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
   */
  async submitSelfOnboarding(
    token: string,
    dto: SelfOnboardingSubmitDto,
  ): Promise<{ ok: true; payoutIgnored?: 'existing' | 'owner_required' }> {
    const { operator, payoutAllowed } = await this.validateSelfOnboardingToken(token);

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
    }

    // Marca progreso de onboarding automáticamente si todavía está NEW
    const current = operator as unknown as { onboardingStatus: string | null };
    if (current.onboardingStatus === 'NEW' || current.onboardingStatus === 'PROFILE_CREATED') {
      data.onboardingStatus = 'INVITE_ACTIVATED';
    }

    // Single-use: invalidamos el token tras submit. La chica pide al admin un
    // link nuevo si quiere volver a editar.
    data.selfOnboardingToken = null;

    // Ruta pública (sin local en el contexto): como la lectura del token, con asSystem.
    await this.prisma.asSystem((tx) => tx.user.update({ where: { id: operator.id }, data }));

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
    if (!operator) {
      throw new UnauthorizedException('Token inválido o ya rotado');
    }
    // Enlaces de antes (sin el dato) cuentan como de encargado.
    return { operator, payoutAllowed: decoded.payout === true };
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

    await this.audit.log({
      action: 'operator.updated',
      tenantId,
      actorId: actorUserId,
      targetType: 'User',
      targetId: operatorId,
      payload: { changes: dto },
    });

    return this.toPublicView(updated);
  }

  async listOperatorEarnings(
    tenantId: string,
    operatorId: string,
    limit = 100,
  ): Promise<EarningView[]> {
    // Verificar que la operadora pertenece a este venue (anti-IDOR)
    const exists = await this.prisma.user.findFirst({
      where: { id: operatorId, tenantId, role: 'OPERATOR' },
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
      where: { id: operatorId, tenantId, role: 'OPERATOR' },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Operadora no encontrada');
    return this.getMyPayouts(operatorId, tenantId, limit);
  }

  /**
   * Marca un payout para una operadora — agrupa todos los earnings sin
   * payoutId actual y los liquida atómicamente.
   * Si el neto agregado es <= 0 (ej. solo deudas pendientes) → 409.
   */
  async createPayout(
    tenantId: string,
    operatorId: string,
    paidByUserId: string,
    notes?: string,
    options?: {
      externalTxId?: string;
      externalRail?: string;
      receiptUrl?: string;
    },
  ) {
    // Verificar pertenencia + leer payoutMethod por defecto
    const operator = await this.prisma.user.findFirst({
      where: { id: operatorId, tenantId, role: 'OPERATOR' },
    }) as unknown as { id: string; payoutMethod: string | null } | null;
    if (!operator) throw new NotFoundException('Operadora no encontrada');

    const result = await this.prisma.$transaction(async (tx) => {
      // Un hash on-chain solo vale para un pago del local.
      const txId = options?.externalTxId?.trim();
      const rail = options?.externalRail ?? operator.payoutMethod ?? null;
      if (txId && isAutoVerifiable(rail as PayoutMethod | null)) {
        const other = await otherPayoutWithTx(tx, tenantId, null, txId);
        if (other) throw txAlreadyUsed(other);
      }

      // SELECT FOR UPDATE de earnings pendientes — incluye tipCents en SUM.
      // L2 (audit): el cálculo previo omitía tipCents → payout subestimaba.
      // Solo earnings con más de N días (PAYOUT_HOLD_DAYS): el dinero ya está
      // abonado por el banco y una devolución temprana no deja deuda.
      const holdDays = this.holdDays();
      const cutoff = payoutCutoff(new Date(), holdDays);
      const pending = await tx.$queryRaw<
        Array<{ id: string; commissionCents: number; tipCents: number; reversedCents: number }>
      >`
        SELECT id, "commissionCents", "tipCents", "reversedCents"
          FROM operator_earnings
         WHERE "operatorId" = ${operatorId}::uuid
           AND "tenantId" = ${tenantId}::uuid
           AND "payoutId" IS NULL
           AND "createdAt" <= ${cutoff}
         FOR UPDATE
      `;

      if (pending.length === 0) {
        throw new ConflictException(
          `No hay comisiones con más de ${holdDays} días para liquidar. Las más recientes siguen en espera.`,
        );
      }

      // Deuda por devoluciones llegadas después de un pago anterior.
      const debts = await tx.$queryRaw<Array<{ id: string; reversedDeltaCents: number }>>`
        SELECT r.id, r."reversedDeltaCents"
          FROM earning_reversals r
          JOIN operator_earnings e ON e.id = r."earningId"
         WHERE e."operatorId" = ${operatorId}::uuid
           AND e."tenantId" = ${tenantId}::uuid
           AND r."afterPayout"
           AND r."settledPayoutId" IS NULL
         FOR UPDATE OF r
      `;

      const totalCents = payoutTotalCents(pending, debts);

      if (totalCents <= 0) {
        throw new ConflictException(
          `Saldo neto ${totalCents / 100} € — no hay nada que liquidar (la operadora arrastra deuda por devoluciones).`,
        );
      }

      // Rail efectivo: el del dto si viene, sino el preferido de la chica.
      const railEffective = options?.externalRail ?? operator.payoutMethod ?? null;

      const payoutData: Record<string, unknown> = {
        tenantId,
        operatorId,
        totalCents,
        paidByUserId,
        notes,
      };
      if (options?.externalTxId) payoutData.externalTxId = options.externalTxId;
      if (railEffective) payoutData.externalRail = railEffective;
      if (options?.receiptUrl) payoutData.receiptUrl = options.receiptUrl;

      // FX snapshot (Track sprint 2026-05-13 #15): si el rail es cripto,
      // congelamos la tasa EUR↔USDT al momento de creación. El verifier
      // on-chain usará este snapshot, no la tasa actual — evita falsos
      // MISMATCH por volatilidad entre creación y verificación.
      if (railEffective && OperatorsService.CRYPTO_RAILS.has(railEffective)) {
        try {
          const fx = await this.fxFactory.getEurToUsdtRateInfo();
          payoutData.payoutFxRate = fx.rate.toFixed(6);
          payoutData.expectedAmountUsdt = ((totalCents / 100) * fx.rate).toFixed(6);
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
      }

      const payout = await tx.operatorPayout.create({ data: payoutData as never });

      // Atomic UPDATE de todos los earnings agrupados
      const ids = pending.map((e) => e.id);
      await tx.$executeRaw`
        UPDATE operator_earnings
           SET "payoutId" = ${payout.id}::uuid
         WHERE id = ANY(${ids}::uuid[])
      `;
      if (debts.length > 0) {
        const debtIds = debts.map((d) => d.id);
        await tx.$executeRaw`
          UPDATE earning_reversals
             SET "settledPayoutId" = ${payout.id}::uuid
           WHERE id = ANY(${debtIds}::uuid[])
        `;
      }

      return { payout, count: pending.length };
    }).catch((err: unknown) => {
      // A la vez, otro pago se quedó el mismo hash (índice único parcial).
      if (isUniqueViolation(err)) throw txAlreadyUsed();
      throw err;
    });

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

  async ensureBelongsToVenue(operatorId: string, tenantId: string): Promise<void> {
    const exists = await this.prisma.user.findFirst({
      where: { id: operatorId, tenantId, role: 'OPERATOR' },
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
