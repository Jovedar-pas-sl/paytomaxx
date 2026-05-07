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
import { randomUUID } from 'node:crypto';
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
  UpdateOperatorDto,
} from '@nightpay/contracts';

const INVITE_TTL_HOURS = 24;

interface InviteJwtPayload {
  sub: string; // userId
  tenantId: string;
  purpose: 'operator-invite';
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
      }>
    >`
      SELECT po.id, po."totalCents", u.email AS "paidByEmail", po.notes,
             (SELECT COUNT(*)::bigint FROM operator_earnings WHERE "payoutId" = po.id) AS "earningCount",
             po."createdAt"
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
    }));
  }

  // ─── Admin (OWNER/MANAGER del venue) ──────────────────────────────

  async listVenueOperators(tenantId: string): Promise<OperatorWithBalance[]> {
    const operators = await this.prisma.user.findMany({
      where: { tenantId, role: 'OPERATOR', deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        displayName: true,
        commissionBps: true,
        deletedAt: true,
        invitedAt: true,
        createdAt: true,
      },
    });

    const result: OperatorWithBalance[] = [];
    for (const op of operators) {
      const balance = await this.getBalance(op.id);
      result.push({
        id: op.id,
        email: op.email,
        displayName: op.displayName,
        commissionBps: op.commissionBps ?? 0,
        active: op.deletedAt === null,
        invitedAt: op.invitedAt?.toISOString() ?? null,
        createdAt: op.createdAt.toISOString(),
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

    // Crear user con passwordHash placeholder (se setea al aceptar invite)
    const placeholderHash = await bcrypt.hash(randomUUID(), 4); // fast hash, nunca usado
    const user = await this.prisma.user.create({
      data: {
        tenantId,
        email,
        displayName: dto.displayName,
        passwordHash: placeholderHash,
        role: 'OPERATOR',
        commissionBps: dto.commissionBps,
        invitedAt: new Date(),
      },
    });

    // Generar JWT inviteToken (TTL 24h)
    const inviteToken = await this.jwt.signAsync(
      { sub: user.id, tenantId, purpose: 'operator-invite' } satisfies InviteJwtPayload,
      { expiresIn: `${INVITE_TTL_HOURS}h` },
    );

    // Persistir token en user (uso único: limpiar al aceptar)
    await this.prisma.user.update({
      where: { id: user.id },
      data: { inviteToken },
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
    if (user.inviteToken !== token) {
      // Token ya usado o invalidado
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

  async updateOperator(
    tenantId: string,
    operatorId: string,
    actorUserId: string,
    dto: UpdateOperatorDto,
  ): Promise<OperatorPublicView> {
    const operator = await this.prisma.user.findFirst({
      where: { id: operatorId, tenantId, role: 'OPERATOR' },
    });
    if (!operator) throw new NotFoundException('Operadora no encontrada');

    const data: Record<string, unknown> = {};
    if (dto.displayName !== undefined) data.displayName = dto.displayName;
    if (dto.commissionBps !== undefined) data.commissionBps = dto.commissionBps;
    if (dto.active !== undefined) {
      data.deletedAt = dto.active ? null : new Date();
    }

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
  ) {
    // Verificar pertenencia
    const operator = await this.prisma.user.findFirst({
      where: { id: operatorId, tenantId, role: 'OPERATOR' },
    });
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

      const payout = await tx.operatorPayout.create({
        data: {
          tenantId,
          operatorId,
          totalCents,
          paidByUserId,
          notes,
        },
      });

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
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      commissionBps: user.commissionBps ?? 0,
      active: user.deletedAt === null,
      invitedAt: user.invitedAt?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
    };
  }
}
