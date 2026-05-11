import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EmailService } from '../../common/email/email.service';
import { AuditService } from '../audit/audit.service';
import type {
  CreateOperatorDto,
  CreateOperatorResponse,
  OperatorBalance,
  OperatorPublicView,
  OperatorWithBalance,
  EarningView,
  PayoutView,
  SelfOnboardingLinkResponse,
  SelfOnboardingProfile,
  SelfOnboardingSubmitDto,
  UpdateOperatorDto,
} from '@nightpay/contracts';

const INVITE_TTL_HOURS = 24;
const SELF_ONBOARDING_TTL_HOURS = 72;

interface InviteJwtPayload {
  sub: string; // userId
  tenantId: string;
  purpose: 'operator-invite';
}

interface SelfOnboardingJwtPayload {
  sub: string; // operatorId
  tenantId: string;
  purpose: 'operator-self-onboarding';
}

/** Hash sha256 hex del token JWT. Persistimos el hash, no el token, en users.inviteToken. */
function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class OperatorsService {
  private readonly logger = new Logger(OperatorsService.name);
  private readonly prisma: PrismaService;
  private readonly email: EmailService;
  private readonly audit: AuditService;
  private readonly config: ConfigService;
  private readonly jwt: JwtService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(EmailService) email: EmailService,
    @Inject(AuditService) audit: AuditService,
    @Inject(ConfigService) config: ConfigService,
    @Inject(JwtService) jwt: JwtService,
  ) {
    this.prisma = prisma;
    this.email = email;
    this.audit = audit;
    this.config = config;
    this.jwt = jwt;
  }

  // ─── Operator self-service (role=OPERATOR) ────────────────────────

  async getBalance(operatorId: string): Promise<OperatorBalance> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        pendingCents: bigint;
        paidCents: bigint;
        lifetimeGrossCents: bigint;
        count: bigint;
      }>
    >`
      SELECT
        COALESCE(SUM(CASE WHEN "payoutId" IS NULL THEN "commissionCents" - "reversedCents" ELSE 0 END), 0)::bigint AS "pendingCents",
        COALESCE(SUM(CASE WHEN "payoutId" IS NOT NULL THEN "commissionCents" - "reversedCents" ELSE 0 END), 0)::bigint AS "paidCents",
        COALESCE(SUM("paymentAmountCents"), 0)::bigint AS "lifetimeGrossCents",
        COUNT(*)::bigint AS count
      FROM operator_earnings
      WHERE "operatorId" = ${operatorId}::uuid
    `;
    const r = rows[0]!;
    return {
      pendingCents: Number(r.pendingCents),
      paidCents: Math.max(0, Number(r.paidCents)),
      lifetimeGrossCents: Number(r.lifetimeGrossCents),
      count: Number(r.count),
    };
  }

  async getMyEarnings(operatorId: string, limit = 50): Promise<EarningView[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        paymentId: string;
        paymentAmountCents: number;
        commissionBps: number;
        commissionCents: number;
        reversedCents: number;
        payoutId: string | null;
        paymentStatus: string;
        createdAt: Date;
      }>
    >`
      SELECT e.id, e."paymentId", e."paymentAmountCents", e."commissionBps",
             e."commissionCents", e."reversedCents", e."payoutId",
             p.status::text AS "paymentStatus", e."createdAt"
        FROM operator_earnings e
        JOIN payments p ON p.id = e."paymentId"
       WHERE e."operatorId" = ${operatorId}::uuid
       ORDER BY e."createdAt" DESC
       LIMIT ${limit}
    `;
    return rows.map((r) => ({
      id: r.id,
      paymentId: r.paymentId,
      paymentAmountCents: r.paymentAmountCents,
      commissionBps: r.commissionBps,
      commissionCents: r.commissionCents,
      reversedCents: r.reversedCents,
      netCents: r.commissionCents - r.reversedCents,
      payoutId: r.payoutId,
      paymentStatus: r.paymentStatus,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async getMyPayments(operatorId: string, limit = 50) {
    return this.prisma.payment.findMany({
      where: { createdByUserId: operatorId },
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

  async getMyPayouts(operatorId: string, limit = 50): Promise<PayoutView[]> {
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
             (SELECT COUNT(*)::bigint FROM operator_earnings WHERE "payoutId" = po.id) AS "earningCount",
             po."createdAt",
             po."externalTxId", po."externalRail", po."reconciliationStatus",
             po."receiptUrl", po."reconciledAt"
        FROM operator_payouts po
        LEFT JOIN users u ON u.id = po."paidByUserId"
       WHERE po."operatorId" = ${operatorId}::uuid
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
      const balance = await this.getBalance(op.id);
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
  ): Promise<CreateOperatorResponse> {
    const email = dto.email.toLowerCase();

    // Validar email único
    const existing = await this.prisma.asSystem((tx) =>
      tx.user.findUnique({ where: { email } }),
    );
    if (existing) {
      throw new ConflictException(`Email ${email} ya está registrado`);
    }

    // Pre-generamos el userId para poder firmar el JWT antes de persistir y mantener
    // todo el alta en una sola transacción atómica (insert user + JWT con su id +
    // update con el hash del token de invite). Si algo falla, rollback completo.
    const userId = randomUUID();
    const placeholderHash = await bcrypt.hash(randomUUID(), 4); // nunca se usa, solo placeholder
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
          commissionBps: dto.commissionBps,
          invitedAt: new Date(),
          inviteToken: inviteTokenHash,
        },
      });
    });

    const baseUrl = this.config.getOrThrow<string>('OPERATOR_BASE_URL');
    const inviteUrl = `${baseUrl.replace(/\/$/, '')}/accept-invite?token=${inviteToken}`;

    // Intentar enviar email — si falla / NoOp, devolvemos URL al admin
    const venue = await this.prisma.venue.findUniqueOrThrow({
      where: { id: tenantId },
      select: { name: true },
    });
    const html = `
      <h2>Bienvenida a ${venue.name}</h2>
      <p>Hola ${dto.displayName},</p>
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
        commissionBps: dto.commissionBps,
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
  ): Promise<SelfOnboardingLinkResponse> {
    const operator = await this.prisma.user.findFirst({
      where: { id: operatorId, tenantId, role: 'OPERATOR' },
      select: { id: true, email: true, deletedAt: true },
    });
    if (!operator) throw new NotFoundException('Operadora no encontrada');
    if (operator.deletedAt) throw new ConflictException('Operadora dada de baja');

    const token = await this.jwt.signAsync(
      {
        sub: operator.id,
        tenantId,
        purpose: 'operator-self-onboarding',
      } satisfies SelfOnboardingJwtPayload,
      { expiresIn: `${SELF_ONBOARDING_TTL_HOURS}h` },
    );
    const tokenHash = hashInviteToken(token);

    await this.prisma.user.update({
      where: { id: operator.id },
      data: { selfOnboardingToken: tokenHash },
    });

    const baseUrl = this.config.getOrThrow<string>('OPERATOR_BASE_URL');
    const url = `${baseUrl.replace(/\/$/, '')}/onboarding/${token}`;
    const expiresAt = new Date(Date.now() + SELF_ONBOARDING_TTL_HOURS * 60 * 60 * 1000);

    await this.audit.log({
      action: 'operator.self_onboarding_link.created',
      tenantId,
      actorId: actorUserId,
      targetType: 'User',
      targetId: operator.id,
      payload: { ttlHours: SELF_ONBOARDING_TTL_HOURS },
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
    const operator = await this.validateSelfOnboardingToken(token);
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
    };
  }

  /**
   * La chica submite su form. Validamos token, actualizamos datos, dejamos el
   * token activo (puede volver a editar dentro de las 72h sin pedir uno nuevo).
   * Si quiere uno nuevo, el admin regenera y el viejo queda invalidado.
   */
  async submitSelfOnboarding(
    token: string,
    dto: SelfOnboardingSubmitDto,
  ): Promise<{ ok: true }> {
    const operator = await this.validateSelfOnboardingToken(token);

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
    if (dto.payoutMethod !== undefined) data.payoutMethod = dto.payoutMethod;
    if (dto.payoutAddress !== undefined) data.payoutAddress = dto.payoutAddress;
    if (dto.payoutLabel !== undefined) data.payoutLabel = dto.payoutLabel;

    // Marca progreso de onboarding automáticamente si todavía está NEW
    const current = operator as unknown as { onboardingStatus: string | null };
    if (current.onboardingStatus === 'NEW' || current.onboardingStatus === 'PROFILE_CREATED') {
      data.onboardingStatus = 'INVITE_ACTIVATED';
    }

    await this.prisma.user.update({
      where: { id: operator.id },
      data,
    });

    await this.audit.log({
      action: 'operator.self_onboarding.submitted',
      tenantId: operator.tenantId,
      actorId: operator.id, // la propia chica es el actor
      targetType: 'User',
      targetId: operator.id,
      payload: { fields: Object.keys(data) },
    });

    this.logger.log(`Self-onboarding submitted by operator=${operator.id}`);
    return { ok: true };
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
    return operator;
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
    // Phase 1A — payout routing
    if (dto.payoutMethod !== undefined) data.payoutMethod = dto.payoutMethod;
    if (dto.payoutAddress !== undefined) data.payoutAddress = dto.payoutAddress;
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
    return this.getMyEarnings(operatorId, limit);
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
    return this.getMyPayouts(operatorId, limit);
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
      // SELECT FOR UPDATE de earnings pendientes
      const pending = await tx.$queryRaw<
        Array<{ id: string; commissionCents: number; reversedCents: number }>
      >`
        SELECT id, "commissionCents", "reversedCents"
          FROM operator_earnings
         WHERE "operatorId" = ${operatorId}::uuid
           AND "payoutId" IS NULL
         FOR UPDATE
      `;

      if (pending.length === 0) {
        throw new ConflictException('No hay earnings pendientes para liquidar');
      }

      const totalCents = pending.reduce(
        (sum, e) => sum + (e.commissionCents - e.reversedCents),
        0,
      );

      if (totalCents <= 0) {
        throw new ConflictException(
          `Saldo neto pendiente es ${totalCents / 100} € — no hay nada que liquidar (la operadora arrastra deuda).`,
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

      const payout = await tx.operatorPayout.create({ data: payoutData as never });

      // Atomic UPDATE de todos los earnings agrupados
      const ids = pending.map((e) => e.id);
      await tx.$executeRaw`
        UPDATE operator_earnings
           SET "payoutId" = ${payout.id}::uuid
         WHERE id = ANY(${ids}::uuid[])
      `;

      return { payout, count: pending.length };
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
