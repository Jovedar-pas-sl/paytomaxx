import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@nightpay/db';
import * as bcrypt from 'bcryptjs';
import { ClsService } from 'nestjs-cls';
import { createHash, randomUUID } from 'node:crypto';
import type {
  CreateStaffUserDto,
  CreateStaffUserResponse,
  ReasonOnlyDto,
  ResetStaffPasswordResponse,
  RevokeSessionsResponse,
  SetSuperAdminDto,
  StaffListQuery,
  StaffUserPage,
  StaffUserView,
  StepUpWithReasonDto,
} from '@nightpay/contracts';
import type { RequestContext } from '../../common/context/request-context';
import { EmailService } from '../../common/email/email.service';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { RefreshTokenService } from '../auth/refresh-token.service';
import { TotpService } from '../auth/totp.service';
import { operatorAppBaseUrl } from '../operators/operator-app-url';
import { OperatorsService } from '../operators/operators.service';
import { inVenue } from '../../common/context/in-venue';
import { SuperAdminStepUpService } from './step-up.service';
import { SuperAdminAuditService } from './superadmin-audit.service';
import { generateTemporaryPassword, superAdminRemovalProblem } from './superadmin-rules';
import type { SuperAdminActor } from './superadmin.guard';

/** Igual que la invitación de la chica: 24 h, mismo enlace /accept-invite de su app. */
const INVITE_TTL_HOURS = 24;
const BCRYPT_ROUNDS = 10;
/** El hash de relleno nunca se compara (se cambia al aceptar): coste mínimo, como en operators. */
const PLACEHOLDER_ROUNDS = 4;
const USER_NOT_FOUND = 'Usuario no encontrado';

const userInclude = { venue: { select: { id: true, name: true, slug: true } } } as const;
type UserRow = Prisma.UserGetPayload<{ include: typeof userInclude }>;

/**
 * Personal y administradores de TODOS los locales (lo que hoy hace la CLI:
 * create-owner/manager/waiter/operator, reset-password, revoke-sessions,
 * set-super-admin; y la 2FA). Todo con acrossVenues: users va por local en el
 * middleware y el super-admin tiene SU local activo en la sesión.
 */
@Injectable()
export class SuperAdminStaffService {
  private readonly prisma: PrismaService;
  private readonly stepUp: SuperAdminStepUpService;
  private readonly audit: SuperAdminAuditService;
  private readonly operators: OperatorsService;
  private readonly refreshTokens: RefreshTokenService;
  private readonly totp: TotpService;
  private readonly jwt: JwtService;
  private readonly config: ConfigService;
  private readonly email: EmailService;
  private readonly cls: ClsService<{ ctx: RequestContext }>;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(SuperAdminStepUpService) stepUp: SuperAdminStepUpService,
    @Inject(SuperAdminAuditService) audit: SuperAdminAuditService,
    @Inject(OperatorsService) operators: OperatorsService,
    @Inject(RefreshTokenService) refreshTokens: RefreshTokenService,
    @Inject(TotpService) totp: TotpService,
    @Inject(JwtService) jwt: JwtService,
    @Inject(ConfigService) config: ConfigService,
    @Inject(EmailService) email: EmailService,
    @Inject(ClsService) cls: ClsService<{ ctx: RequestContext }>,
  ) {
    this.prisma = prisma;
    this.stepUp = stepUp;
    this.audit = audit;
    this.operators = operators;
    this.refreshTokens = refreshTokens;
    this.totp = totp;
    this.jwt = jwt;
    this.config = config;
    this.email = email;
    this.cls = cls;
  }

  // ─── Lectura ──────────────────────────────────────────────────────────

  async list(query: StaffListQuery): Promise<StaffUserPage> {
    const q = query.q?.trim();
    const where: Prisma.UserWhereInput = {
      ...(query.venueId ? { tenantId: query.venueId } : {}),
      ...(query.role ? { role: query.role } : {}),
      ...(query.active === undefined ? {} : query.active ? { deletedAt: null } : { deletedAt: { not: null } }),
      ...(query.superAdmin === undefined ? {} : { isSuperAdmin: query.superAdmin }),
      ...(q
        ? { OR: [{ email: { contains: q, mode: 'insensitive' } }, { displayName: { contains: q, mode: 'insensitive' } }] }
        : {}),
    };
    const rows = await this.prisma.acrossVenues((tx) =>
      tx.user.findMany({
        where,
        include: userInclude,
        orderBy: { email: 'asc' },
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      }),
    );
    const page = rows.slice(0, query.limit);
    const lastLogins = await this.lastLogins(page.map((u) => u.id));
    return {
      items: page.map((u) => toStaffView(u, lastLogins.get(u.id) ?? null)),
      nextCursor: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  async get(id: string): Promise<StaffUserView> {
    const user = await this.load(id);
    const lastLogins = await this.lastLogins([id]);
    return toStaffView(user, lastLogins.get(id) ?? null);
  }

  // ─── Altas ────────────────────────────────────────────────────────────

  /**
   * Alta en un local con enlace de invitación (24 h, la persona pone su
   * contraseña; nunca se devuelve una). Chica: el alta de siempre
   * (OperatorsService, con email); dueño/encargado/camarero: la misma
   * invitación (acepta en /accept-invite y entra con su email en su app).
   */
  async create(actor: SuperAdminActor, dto: CreateStaffUserDto): Promise<CreateStaffUserResponse> {
    await this.stepUp.verify(actor, dto.totpCode, 'user.create');
    const venue = await this.prisma.acrossVenues((tx) =>
      tx.venue.findFirst({ where: { id: dto.venueId, deletedAt: null }, select: { id: true, name: true } }),
    );
    if (!venue) throw new NotFoundException('Local no encontrado');
    await this.assertEmailFree(dto.email);

    const created =
      dto.role === 'OPERATOR'
        ? await this.createOperator(actor, dto)
        : await this.createStaff(dto, venue.name);
    await this.audit.write(actor, {
      action: 'user.created',
      tenantId: venue.id,
      targetType: 'User',
      targetId: created.userId,
      after: { email: dto.email, role: dto.role, displayName: dto.displayName ?? null, commissionBps: dto.commissionBps ?? null },
      extra: { emailSent: created.emailSent },
    });
    return { user: await this.get(created.userId), inviteUrl: created.inviteUrl, expiresAt: created.expiresAt, emailSent: created.emailSent };
  }

  /** La chica, con el alta de siempre, como si la diera el dueño de ESE local. */
  private async createOperator(actor: SuperAdminActor, dto: CreateStaffUserDto) {
    const res = await inVenue(this.cls, dto.venueId, () =>
      this.operators.createOperator(
        dto.venueId,
        actor.id,
        { email: dto.email, displayName: dto.displayName ?? dto.email, commissionBps: dto.commissionBps },
        'OWNER',
      ),
    );
    return { userId: res.operator.id, inviteUrl: res.inviteUrl, expiresAt: inviteExpiry(), emailSent: res.emailSent };
  }

  private async createStaff(dto: CreateStaffUserDto, venueName: string) {
    const baseUrl = this.appUrl();
    const userId = randomUUID();
    const { token, hash } = await this.inviteToken(userId, dto.venueId);
    const placeholder = await bcrypt.hash(randomUUID(), PLACEHOLDER_ROUNDS);
    await this.prisma.acrossVenues((tx) =>
      tx.user.create({
        data: {
          id: userId,
          tenantId: dto.venueId,
          email: dto.email,
          displayName: dto.displayName ?? null,
          passwordHash: placeholder,
          role: dto.role,
          invitedAt: new Date(),
          inviteToken: hash,
        },
      }),
    ).catch(emailClash);
    const inviteUrl = `${baseUrl}/accept-invite?token=${token}`;
    const sent = await this.email.send({
      to: dto.email,
      subject: `Activa tu cuenta en ${venueName}`,
      html: `<p>Te han dado de alta en ${escapeHtml(venueName)}. Crea tu contraseña en este enlace (válido ${INVITE_TTL_HOURS} h):</p><p><a href="${inviteUrl}">Activar cuenta</a></p>`,
      text: `Activa tu cuenta: ${inviteUrl}`,
    });
    return { userId, inviteUrl, expiresAt: inviteExpiry(), emailSent: sent.delivered };
  }

  // ─── Acceso ───────────────────────────────────────────────────────────

  /**
   * Como el reset de la chica de hoy: sin activar → invitación nueva; ya
   * activada → contraseña temporal (se ve una vez, solo se guarda el hash).
   * Se cierran sus sesiones.
   */
  async resetPassword(actor: SuperAdminActor, id: string, dto: StepUpWithReasonDto): Promise<ResetStaffPasswordResponse> {
    await this.stepUp.verify(actor, dto.totpCode, 'user.reset_password');
    const user = await this.load(id);
    if (user.deletedAt) throw new ConflictException('Usuario dado de baja: dale de alta antes');
    let result: ResetStaffPasswordResponse;
    if (user.invitedAt) {
      const baseUrl = this.appUrl();
      const { token, hash } = await this.inviteToken(user.id, user.tenantId);
      await this.prisma.acrossVenues((tx) =>
        tx.user.update({ where: { id }, data: { inviteToken: hash, invitedAt: new Date() } }),
      );
      const revokedSessions = await this.refreshTokens.revokeAllForUser(id);
      result = { kind: 'invite', inviteUrl: `${baseUrl}/accept-invite?token=${token}`, expiresAt: inviteExpiry(), revokedSessions };
    } else {
      const password = generateTemporaryPassword();
      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      await this.prisma.acrossVenues((tx) =>
        tx.user.update({ where: { id }, data: { passwordHash, inviteToken: null } }),
      );
      const revokedSessions = await this.refreshTokens.revokeAllForUser(id);
      result = { kind: 'password', password, revokedSessions };
    }
    await this.audit.write(actor, {
      action: 'user.password_reset',
      tenantId: user.tenantId,
      targetType: 'User',
      targetId: id,
      reason: dto.reason,
      extra: { kind: result.kind, revokedSessions: result.revokedSessions },
    });
    return result;
  }

  /** Baja: no entra y se cierran sus sesiones. Ni a ti mismo ni al último super-admin. */
  async disable(actor: SuperAdminActor, id: string, dto: StepUpWithReasonDto): Promise<StaffUserView> {
    await this.stepUp.verify(actor, dto.totpCode, 'user.disable');
    if (id === actor.id) throw new BadRequestException('No te puedes dar de baja a ti mismo');
    const tenantId = await this.prisma.acrossVenues(async (tx) => {
      const user = await this.lockUser(tx, id);
      if (user.deletedAt) throw new ConflictException('Ya está dado de baja');
      if (user.isSuperAdmin) await this.assertNotLastSuperAdmin(tx, actor, id);
      await tx.user.update({ where: { id }, data: { deletedAt: new Date() } });
      return user.tenantId;
    });
    const revoked = await this.refreshTokens.revokeAllForUser(id);
    await this.audit.write(actor, {
      action: 'user.disabled',
      tenantId,
      targetType: 'User',
      targetId: id,
      before: { active: true },
      after: { active: false },
      reason: dto.reason,
      extra: { revokedSessions: revoked },
    });
    return this.get(id);
  }

  async enable(actor: SuperAdminActor, id: string, dto: StepUpWithReasonDto): Promise<StaffUserView> {
    await this.stepUp.verify(actor, dto.totpCode, 'user.enable');
    const user = await this.load(id);
    if (!user.deletedAt) throw new ConflictException('Ya está activo');
    await this.prisma.acrossVenues((tx) => tx.user.update({ where: { id }, data: { deletedAt: null } }));
    await this.audit.write(actor, {
      action: 'user.enabled',
      tenantId: user.tenantId,
      targetType: 'User',
      targetId: id,
      before: { active: false },
      after: { active: true },
      reason: dto.reason,
    });
    return this.get(id);
  }

  /** Cierra sus sesiones (protege: sin 2FA). Superadmin exige la sesión viva; el acceso local caduca en ≤ 1 h. */
  async revokeSessions(actor: SuperAdminActor, id: string, dto: ReasonOnlyDto): Promise<RevokeSessionsResponse> {
    const user = await this.load(id);
    const revoked = await this.refreshTokens.revokeAllForUser(id);
    await this.audit.write(actor, {
      action: 'user.sessions_revoked',
      tenantId: user.tenantId,
      targetType: 'User',
      targetId: id,
      reason: dto.reason,
      extra: { revoked },
    });
    return { revoked };
  }

  /** Borra su 2FA: tendrá que activarla otra vez (y se cierran sus sesiones). */
  async resetTotp(actor: SuperAdminActor, id: string, dto: StepUpWithReasonDto): Promise<StaffUserView> {
    await this.stepUp.verify(actor, dto.totpCode, 'user.totp_reset');
    if (id === actor.id) throw new BadRequestException('Tu propia 2FA se cambia desde tu perfil');
    const user = await this.load(id);
    if (!user.totpSecret) throw new ConflictException('No tiene la 2FA activada');
    await this.prisma.acrossVenues((tx) => tx.user.update({ where: { id }, data: { totpSecret: null } }));
    await this.totp.forgetUsedCodes(id);
    const revoked = await this.refreshTokens.revokeAllForUser(id);
    await this.audit.write(actor, {
      action: 'user.totp_reset',
      tenantId: user.tenantId,
      targetType: 'User',
      targetId: id,
      before: { totpEnabled: true },
      after: { totpEnabled: false },
      reason: dto.reason,
      extra: { revokedSessions: revoked },
    });
    return this.get(id);
  }

  /** Dar o quitar super-admin (solo a un dueño activo; nunca dejar la plataforma sin ninguno). */
  async setSuperAdmin(actor: SuperAdminActor, id: string, dto: SetSuperAdminDto): Promise<StaffUserView> {
    await this.stepUp.verify(actor, dto.totpCode, 'user.super_admin');
    const outcome = await this.prisma.acrossVenues(async (tx) => {
      const user = await this.lockUser(tx, id);
      if (user.isSuperAdmin === dto.enabled) {
        throw new ConflictException(dto.enabled ? 'Ya es super-admin' : 'No es super-admin');
      }
      if (dto.enabled && (user.role !== 'OWNER' || user.deletedAt)) {
        throw new BadRequestException('Solo un dueño (OWNER) activo puede ser super-admin');
      }
      if (!dto.enabled) await this.assertNotLastSuperAdmin(tx, actor, id);
      await tx.user.update({ where: { id }, data: { isSuperAdmin: dto.enabled } });
      return user.tenantId;
    });
    await this.audit.write(actor, {
      action: dto.enabled ? 'user.super_admin_granted' : 'user.super_admin_revoked',
      tenantId: outcome,
      targetType: 'User',
      targetId: id,
      before: { isSuperAdmin: !dto.enabled },
      after: { isSuperAdmin: dto.enabled },
      reason: dto.reason,
    });
    return this.get(id);
  }

  // ─── Auxiliares ───────────────────────────────────────────────────────

  private async load(id: string): Promise<UserRow> {
    const user = await this.prisma.acrossVenues((tx) => tx.user.findUnique({ where: { id }, include: userInclude }));
    if (!user) throw new NotFoundException(USER_NOT_FOUND);
    return user;
  }

  /** La fila bloqueada hasta el final de la transacción (dos cambios a la vez esperan). */
  private async lockUser(tx: TransactionalClient, id: string) {
    const rows = await tx.$queryRaw<
      Array<{ id: string; tenantId: string; role: string; isSuperAdmin: boolean; deletedAt: Date | null }>
    >`SELECT id, "tenantId", role::text AS role, "isSuperAdmin", "deletedAt" FROM users WHERE id = ${id}::uuid FOR UPDATE`;
    const user = rows[0];
    if (!user) throw new NotFoundException(USER_NOT_FOUND);
    return user;
  }

  /** Con los super-admins activos bloqueados: dos bajas a la vez no dejan cero. */
  private async assertNotLastSuperAdmin(tx: TransactionalClient, actor: SuperAdminActor, targetId: string): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM users WHERE "isSuperAdmin" AND "deletedAt" IS NULL ORDER BY id FOR UPDATE
    `;
    const problem = superAdminRemovalProblem({
      activeSuperAdminIds: rows.map((r) => r.id),
      targetId,
      actorId: actor.id,
    });
    if (problem) throw new ConflictException(problem);
  }

  private async assertEmailFree(email: string): Promise<void> {
    const taken = await this.prisma.acrossVenues((tx) =>
      tx.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } }, select: { id: true } }),
    );
    if (taken) throw new ConflictException(`El email ${email} ya está registrado`);
  }

  /** Último login correcto de cada uno (audit_events auth.login.ok). */
  private async lastLogins(ids: string[]): Promise<Map<string, Date>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.acrossVenues((tx) => tx.$queryRaw<Array<{ actorId: string; at: Date }>>`
      SELECT DISTINCT ON ("actorId") "actorId", "occurredAt" AS at
        FROM audit_events
       WHERE action = 'auth.login.ok' AND "actorId" = ANY(${ids}::uuid[])
       ORDER BY "actorId", "occurredAt" DESC
    `);
    return new Map(rows.map((r) => [r.actorId, r.at]));
  }

  private async inviteToken(userId: string, tenantId: string): Promise<{ token: string; hash: string }> {
    // Mismo JWT que la invitación de la chica: lo acepta POST /operators/accept-invite.
    const token = await this.jwt.signAsync(
      { sub: userId, tenantId, purpose: 'operator-invite' },
      { expiresIn: `${INVITE_TTL_HOURS}h` },
    );
    return { token, hash: createHash('sha256').update(token).digest('hex') };
  }

  private appUrl(): string {
    const url = operatorAppBaseUrl({
      operatorBaseUrl: this.config.get<string>('OPERATOR_BASE_URL'),
      operatorUrl: this.config.get<string>('NEXT_PUBLIC_OPERATOR_URL'),
      apiUrl: this.config.get<string>('NEXT_PUBLIC_API_URL'),
      production: this.config.get<string>('NODE_ENV') === 'production',
    });
    if (!url) throw new ServiceUnavailableException('Falta la dirección de la app para la invitación: configura OPERATOR_BASE_URL');
    return url;
  }
}

export function toStaffView(u: UserRow, lastLoginAt: Date | null): StaffUserView {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    venue: u.venue,
    active: u.deletedAt === null,
    invitePending: u.invitedAt !== null,
    totpEnabled: Boolean(u.totpSecret),
    isSuperAdmin: u.isSuperAdmin,
    lastLoginAt: lastLoginAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
  };
}

function inviteExpiry(): string {
  return new Date(Date.now() + INVITE_TTL_HOURS * 3600 * 1000).toISOString();
}

function emailClash(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    throw new ConflictException('Ese email ya está registrado');
  }
  throw err;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
