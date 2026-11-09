import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHash } from 'node:crypto';
import type { Prisma } from '@nightpay/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MetricsService } from '../metrics/metrics.service';
import { ACCOUNT_POLICY, LockoutService, PER_IP_POLICY } from './lockout.service';
import { clampEmail, loginLockKeys, normalizeLoginEmail, type LoginLockKeys } from './login-keys';
import {
  passwordFingerprint,
  RefreshTokenReuseError,
  RefreshTokenService,
  type RotatedRefresh,
} from './refresh-token.service';
import { TotpService } from './totp.service';
import { ACCESS_TOKEN_TTL_SECONDS } from './access-revocation.service';
import { TotpEnrollmentService } from './totp-enrollment.service';
import {
  LOGIN_ENROLL_TICKET_TTL_SECONDS,
  LOGIN_TICKET_TTL_SECONDS,
  LoginTicketService,
  type LoginTicketPurpose,
} from './login-ticket.service';
import {
  LOGIN_TICKET_EXPIRED_CODE,
  LOGIN_TOTP_REQUIRED_CODE,
  LOGIN_TOTP_SETUP_REQUIRED_CODE,
  type JwtPayload,
  type LoginRequest,
  type LoginResponse,
  type RefreshResponse,
  type TotpSetupResponse,
} from '@nightpay/contracts';

const BCRYPT_ROUNDS = 10;
// El token de acceso dura 1 h (ACCESS_TOKEN_TTL_SECONDS) y el refresco
// (automático en las apps) comprueba que el usuario sigue activo. Cerrar una
// sesión (logout, revocar, baja, contraseña nueva) lo corta al momento:
// AuthGuard mira AccessRevocationService en cada petición.
/**
 * Hash bcrypt (coste 10) de un valor aleatorio que nadie conoce. Con un email
 * que no existe comparamos contra él: así tarda lo mismo que una contraseña
 * mala y el tiempo de respuesta no delata qué emails tienen cuenta.
 */
const DUMMY_BCRYPT_HASH = '$2a$10$YCDVBJQHMCybY9.Zlf5Dm.oZuv2KIafKULqsAsPLpccT3vUlP/CxK';
/** Usuarios con el mismo email salvo mayúsculas: más que esto no es un caso real. */
const MAX_LOGIN_CANDIDATES = 10;
const MSG_BAD_CREDENTIALS = 'Email o contraseña incorrectos';
const MSG_TOO_MANY_ATTEMPTS = 'Demasiados intentos. Espera unos minutos y vuelve a probar.';
const MSG_LOGIN_TOTP = 'Pon el código de tu app de verificación (2FA) para entrar.';
const MSG_LOGIN_TICKET_EXPIRED = 'Ha pasado demasiado tiempo: vuelve a poner tu contraseña.';
const MSG_LOGIN_TOTP_SETUP =
  'Debes activar la verificación en dos pasos (2FA) para entrar: es obligatoria para los super-admins.';
const MSG_SUPERADMIN_RELOGIN = 'Por seguridad, vuelve a entrar con tu código de verificación (2FA).';
const MSG_SESSION_CLOSED = 'Sesión caducada: vuelve a iniciar sesión';

function ticketExpired(): UnauthorizedException {
  return new UnauthorizedException({ message: MSG_LOGIN_TICKET_EXPIRED, code: LOGIN_TICKET_EXPIRED_CODE });
}

/** Ata el QR pendiente al ticket del login (no se guarda el ticket, solo su hash). */
function ticketScope(ticket: string): string {
  return `login:${createHash('sha256').update(ticket).digest('hex').slice(0, 32)}`;
}

/** Lo que le queda al access token (`exp`, en s), como mucho 1 h; sin `exp` o caducado, 401. */
function remainingSeconds(exp: number | undefined, nowMs: number = Date.now()): number {
  const left = typeof exp === 'number' ? Math.floor(exp - nowMs / 1000) : 0;
  if (left <= 0) throw new UnauthorizedException(MSG_SESSION_CLOSED);
  return Math.min(left, ACCESS_TOKEN_TTL_SECONDS);
}

type LoginUser = Prisma.UserGetPayload<{ include: { venue: true } }>;

/** El nombre de Personal que pinta la app; sin nombre (o solo espacios), null: la app pinta el puesto. */
function visibleName(displayName: string | null | undefined): string | null {
  return displayName?.trim() || null;
}

/** Lo que emite el servicio: siempre con el refresh token (el controlador decide si va en cookie o en el cuerpo). */
export type IssuedLogin = LoginResponse & { refreshToken: string };
export type IssuedRefresh = RefreshResponse & { refreshToken: string };

export interface SwitchTenantOptions {
  /** Código 2FA: obligatorio para entrar en un local que no es el suyo. */
  totpCode?: string;
  /** sid del access token: la sesión que recuerda el local elegido. Sin ella, 401. */
  sessionId?: string;
  /** `exp` del access token con el que se pide (s): el nuevo no dura más. */
  tokenExp?: number;
  ip?: string;
  userAgent?: string;
}

interface VenueRef {
  readonly id: string;
  readonly slug: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly prisma: PrismaService;
  private readonly jwt: JwtService;
  private readonly lockout: LockoutService;
  private readonly audit: AuditService;
  private readonly metrics: MetricsService;
  private readonly refreshTokens: RefreshTokenService;
  private readonly totp: TotpService;
  private readonly loginTickets: LoginTicketService | null;
  private readonly enrollment: TotpEnrollmentService | null;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(JwtService) jwt: JwtService,
    @Inject(LockoutService) lockout: LockoutService,
    @Inject(AuditService) audit: AuditService,
    @Inject(MetricsService) metrics: MetricsService,
    @Inject(RefreshTokenService) refreshTokens: RefreshTokenService,
    @Inject(TotpService) totp: TotpService,
    @Optional() @Inject(LoginTicketService) loginTickets?: LoginTicketService,
    @Optional() @Inject(TotpEnrollmentService) enrollment?: TotpEnrollmentService,
  ) {
    this.prisma = prisma;
    this.jwt = jwt;
    this.lockout = lockout;
    this.audit = audit;
    this.metrics = metrics;
    this.refreshTokens = refreshTokens;
    this.totp = totp;
    this.loginTickets = loginTickets ?? null;
    this.enrollment = enrollment ?? null;
  }

  async hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, BCRYPT_ROUNDS);
  }

  async verifyPassword(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }

  /**
   * Login. Cross-tenant por diseno (no sabemos tenant antes del lookup).
   * - Lockout via Redis (multi-nodo safe); política en LockoutService. El
   *   intento se cuenta antes de bcrypt (reserveAttempt, atómico).
   * - Audit log de exitos y fallos.
   */
  async login(input: LoginRequest, ip?: string, userAgent?: string): Promise<IssuedLogin> {
    const keys = loginLockKeys(input.email, ip);
    const attempt = await this.reserveLoginAttempt(keys, input.email, ip, userAgent);

    const user = await this.findLoginUser(input.email);
    // Sin usuario se compara igual contra un hash ficticio (mismo tiempo).
    const ok = await this.verifyPassword(input.password, user?.passwordHash ?? DUMMY_BCRYPT_HASH);
    if (!user || !ok) {
      return this.failLogin(attempt, input.email, user, ip, userAgent);
    }

    if (input.venueSlug && input.venueSlug !== user.venue.slug) {
      this.logger.warn(
        `Login rejected: user ${user.email} requested venue ${input.venueSlug} but belongs to ${user.venue.slug}`,
      );
      await this.audit.log({
        action: 'auth.login.failed',
        actorId: user.id,
        actorEmail: user.email,
        tenantId: user.tenantId,
        ip,
        userAgent,
        payload: { reason: 'venue_mismatch', requested: input.venueSlug },
      });
      throw new UnauthorizedException('Este usuario no es de ese local');
    }

    await this.lockout.clear(keys.ip);
    await this.lockout.clear(keys.account);
    if (keys.trusted) await this.lockout.markTrusted(keys.trusted);

    // Super-admin: la contraseña sola no abre la sesión (con ella se entra en
    // todos los locales). Con la 2FA, 401 TOTP_REQUIRED con un ticket de 5 min
    // (el panel pide el código y llama a /auth/login/totp). Sin ella (es
    // obligatoria), 401 TOTP_SETUP_REQUIRED: el ticket solo sirve para
    // activarla (/auth/login/totp/setup y /enroll).
    if (user.isSuperAdmin) {
      const purpose: LoginTicketPurpose = (await this.totp.isEnabled(user.id)) ? 'code' : 'enroll';
      return this.askSecondStep(user, purpose, ip, userAgent);
    }
    // Quien tiene la 2FA activada (dueño, encargado): tampoco entra con la contraseña sola.
    if (await this.totp.isEnabled(user.id)) return this.askSecondStep(user, 'code', ip, userAgent);
    return this.issueLogin(user, ip, userAgent, false);
  }

  /** Segundo paso del login con 2FA: el ticket de la contraseña y el código. */
  async loginWithTotp(ticket: string, totpCode: string, ip?: string, userAgent?: string): Promise<IssuedLogin> {
    const user = await this.ticketUser(ticket, 'code');
    // Código malo: 403 TOTP_INVALID (el ticket sigue valiendo); 5 seguidos bloquean (429).
    await this.totp.assertForUser(user.id, totpCode);
    return this.finishTicketLogin(ticket, user, ip, userAgent);
  }

  /** Super-admin sin 2FA: con el ticket `enroll`, el QR para activarla (mismo QR mientras dure el ticket). */
  async loginTotpSetup(ticket: string): Promise<TotpSetupResponse> {
    const user = await this.ticketUser(ticket, 'enroll');
    return this.requireEnrollment().setupAtLogin(user.id, ticketScope(ticket));
  }

  /** Super-admin sin 2FA: un código del QR la activa y abre la sesión (ya con la 2FA). */
  async loginWithNewTotp(ticket: string, totpCode: string, ip?: string, userAgent?: string): Promise<IssuedLogin> {
    const user = await this.ticketUser(ticket, 'enroll');
    // Código malo: 403 (el ticket sigue valiendo); sin QR de este ticket: 409.
    await this.requireEnrollment().confirmAtLogin(user.id, totpCode, ticketScope(ticket), { ip, userAgent });
    return this.finishTicketLogin(ticket, user, ip, userAgent);
  }

  /** El usuario del ticket (de ese tipo); baja, contraseña cambiada o, al activarla en el login, ya no super-admin: vuelta a empezar. */
  private async ticketUser(ticket: string, purpose: LoginTicketPurpose): Promise<LoginUser> {
    const tickets = this.requireTickets();
    const pending = await tickets.peek(ticket);
    if (!pending || pending.purpose !== purpose) throw ticketExpired();
    const user = await this.prisma.asSystem((tx) =>
      tx.user.findUnique({ where: { id: pending.userId }, include: { venue: true } }),
    );
    const mustBeSuperAdmin = purpose === 'enroll';
    if (!user || user.deletedAt || (mustBeSuperAdmin && !user.isSuperAdmin) || passwordFingerprint(user.passwordHash) !== pending.pwdFp) {
      await tickets.consume(ticket);
      throw ticketExpired();
    }
    return user;
  }

  /** Gasta el ticket (dos peticiones a la vez no abren dos sesiones) y abre la sesión con la 2FA. */
  private async finishTicketLogin(ticket: string, user: LoginUser, ip?: string, userAgent?: string): Promise<IssuedLogin> {
    if (!(await this.requireTickets().consume(ticket))) throw ticketExpired();
    return this.issueLogin(user, ip, userAgent, true);
  }

  private requireTickets(): LoginTicketService {
    if (!this.loginTickets) throw new Error('LoginTicketService no está disponible');
    return this.loginTickets;
  }

  private requireEnrollment(): TotpEnrollmentService {
    if (!this.enrollment) throw new Error('TotpEnrollmentService no está disponible');
    return this.enrollment;
  }

  private async askSecondStep(
    user: LoginUser,
    purpose: LoginTicketPurpose,
    ip?: string,
    userAgent?: string,
  ): Promise<never> {
    const enroll = purpose === 'enroll';
    const expiresIn = enroll ? LOGIN_ENROLL_TICKET_TTL_SECONDS : LOGIN_TICKET_TTL_SECONDS;
    const loginTicket = await this.requireTickets().create(
      { userId: user.id, pwdFp: passwordFingerprint(user.passwordHash), purpose },
      expiresIn,
    );
    await this.audit.log({
      action: enroll ? 'auth.login.totp_setup_required' : 'auth.login.totp_required',
      actorId: user.id,
      actorEmail: user.email,
      tenantId: user.tenantId,
      ip,
      userAgent,
    });
    throw new UnauthorizedException({
      message: enroll ? MSG_LOGIN_TOTP_SETUP : MSG_LOGIN_TOTP,
      code: enroll ? LOGIN_TOTP_SETUP_REQUIRED_CODE : LOGIN_TOTP_REQUIRED_CODE,
      loginTicket,
      expiresIn,
    });
  }

  /** Sesión nueva (access + refresh). `twoFactor`: entró con el código (lo recuerda la sesión). */
  private async issueLogin(user: LoginUser, ip: string | undefined, userAgent: string | undefined, twoFactor: boolean): Promise<IssuedLogin> {
    const refresh = await this.refreshTokens.issue(user.id, user.tenantId, {
      pwdFp: passwordFingerprint(user.passwordHash),
    });
    if (twoFactor) await this.refreshTokens.markTwoFactor(refresh.family);

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
      venueSlug: user.venue.slug,
      sid: refresh.family,
    };

    const accessToken = await this.jwt.signAsync(payload, {
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    });

    this.metrics.authLogins.inc({ outcome: 'ok' });
    await this.audit.log({
      action: 'auth.login.ok',
      actorId: user.id,
      actorEmail: user.email,
      tenantId: user.tenantId,
      ip,
      userAgent,
      ...(twoFactor ? { payload: { twoFactor: true } } : {}),
    });

    this.logger.log(`Login OK: ${user.email} (${user.role}) -> venue ${user.venue.slug}`);

    return {
      accessToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      refreshToken: refresh.token,
      refreshExpiresIn: refresh.ttlSeconds,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        tenantId: user.tenantId,
        venueSlug: user.venue.slug,
        isSuperAdmin: user.isSuperAdmin,
        displayName: visibleName(user.displayName),
      },
    };
  }

  /**
   * Cuenta el intento (por IP y por cuenta) ANTES de mirar la contraseña, en
   * un solo paso en Redis: muchas peticiones a la vez no prueban más de 5
   * contraseñas. Bloqueo por IP siempre; el de cuenta no aplica a una pareja
   * email|IP de confianza. Devuelve los fallos por IP contando este.
   */
  private async reserveLoginAttempt(
    keys: LoginLockKeys,
    email: string,
    ip?: string,
    userAgent?: string,
  ): Promise<number> {
    const trusted = keys.trusted ? await this.lockout.isTrusted(keys.trusted) : false;
    const attempt = await this.lockout.reserveAttempt([
      { key: keys.ip, policy: PER_IP_POLICY },
      { key: keys.account, policy: ACCOUNT_POLICY, enforce: !trusted },
    ]);
    if (attempt.allowed) return attempt.counts[0] ?? 0;

    this.metrics.authLogins.inc({ outcome: 'locked' });
    this.logger.warn(`Login locked for ${keys.ip} (${attempt.ttlSeconds}s remaining)`);
    await this.audit.log({
      action: 'auth.login.locked',
      actorEmail: clampEmail(email),
      ip,
      userAgent,
      payload: { ttlSeconds: attempt.ttlSeconds, scope: attempt.gate === 0 ? 'ip' : 'account' },
    });
    throw new UnauthorizedException(MSG_TOO_MANY_ATTEMPTS);
  }

  /**
   * Email sin distinguir mayúsculas (hay usuarios antiguos guardados con
   * mayúsculas). ILIKE trata el guion bajo como comodín, así que se filtra
   * otra vez en código; si hay varias variantes gana la exacta y, si no hay
   * exacta, no se adivina cuál es.
   */
  private async findLoginUser(email: string): Promise<LoginUser | null> {
    const wanted = normalizeLoginEmail(email);
    const candidates = await this.prisma.asSystem((tx) =>
      tx.user.findMany({
        where: { email: { equals: wanted, mode: 'insensitive' }, deletedAt: null },
        include: { venue: true },
        take: MAX_LOGIN_CANDIDATES,
      }),
    );
    const same = candidates.filter((u) => u.email.toLowerCase() === wanted);
    const exact = same.find((u) => u.email === email.trim());
    if (exact) return exact;
    if (same.length > 1) {
      this.logger.warn(`Login: ${same.length} cuentas con el mismo email salvo mayúsculas; ninguna exacta`);
    }
    return same.length === 1 ? (same[0] ?? null) : null;
  }

  /** El intento ya se contó al reservarlo (reserveLoginAttempt): aquí solo queda apuntarlo. */
  private async failLogin(
    count: number,
    email: string,
    user: LoginUser | null,
    ip?: string,
    userAgent?: string,
  ): Promise<never> {
    const locked = count >= PER_IP_POLICY.threshold;
    this.metrics.authLogins.inc({ outcome: 'failed' });
    await this.audit.log({
      action: 'auth.login.failed',
      actorId: user?.id,
      actorEmail: user?.email ?? clampEmail(email),
      tenantId: user?.tenantId,
      ip,
      userAgent,
      payload: { reason: user ? 'bad_password' : 'unknown_user', count, locked },
    });
    throw new UnauthorizedException(MSG_BAD_CREDENTIALS);
  }

  /**
   * Intercambia un refresh token por un nuevo access token (y rota el refresh).
   * Falla con 401 si el token no es valido, esta caducado o se detecta reuso.
   */
  async refresh(refreshToken: string, ip?: string, userAgent?: string): Promise<IssuedRefresh> {
    const rotated = await this.rotateRefresh(refreshToken, ip, userAgent);

    // Cargar user actualizado para verificar que sigue activo y obtener role/venueSlug actuales
    const user = await this.prisma.asSystem((tx) =>
      tx.user.findUnique({
        where: { id: rotated.userId },
        include: { venue: true },
      }),
    );
    if (!user || user.deletedAt) {
      // Usuario desactivado tras emitir el refresh — invalidamos todo lo suyo y rechazamos.
      await this.refreshTokens.revokeAllForUser(rotated.userId);
      throw new UnauthorizedException('Usuario desactivado');
    }
    await this.assertSamePassword(rotated, user, ip, userAgent);
    await this.assertSuperAdminTwoFactor(rotated.family, user, ip, userAgent);

    const venue = await this.sessionVenue(rotated.family, user);
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      tenantId: venue.id,
      venueSlug: venue.slug,
      sid: rotated.family,
    };
    const accessToken = await this.jwt.signAsync(payload, {
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    });

    await this.audit.log({
      action: 'auth.refresh.ok',
      actorId: user.id,
      actorEmail: user.email,
      tenantId: user.tenantId,
      ip,
      userAgent,
    });

    return {
      accessToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      refreshToken: rotated.token,
      refreshExpiresIn: rotated.ttlSeconds,
      displayName: visibleName(user.displayName),
    };
  }

  /**
   * El local del access token: el suyo, o el que el super-admin eligió (con
   * 2FA) en esta sesión, si sigue siendo super-admin y el local existe.
   */
  private async sessionVenue(
    family: string,
    user: { tenantId: string; isSuperAdmin: boolean; venue: { slug: string } },
  ): Promise<VenueRef> {
    const home: VenueRef = { id: user.tenantId, slug: user.venue.slug };
    const chosen = await this.refreshTokens.activeVenue(family);
    if (!chosen || chosen === home.id) return home;
    const venue = user.isSuperAdmin
      ? await this.prisma.asSystem((tx) =>
          tx.venue.findUnique({ where: { id: chosen }, select: { id: true, slug: true, deletedAt: true } }),
        )
      : null;
    if (venue && !venue.deletedAt) return { id: venue.id, slug: venue.slug };
    await this.refreshTokens.setActiveVenue(family, null);
    return home;
  }

  /** Rota el refresh; si era un reuso (robo), lo deja en el audit antes de rechazarlo. */
  private async rotateRefresh(refreshToken: string, ip?: string, userAgent?: string): Promise<RotatedRefresh> {
    try {
      return await this.refreshTokens.rotate(refreshToken);
    } catch (err) {
      if (err instanceof RefreshTokenReuseError) {
        await this.audit.log({
          action: 'auth.refresh.reuse_detected',
          actorId: err.userId,
          tenantId: err.tenantId,
          ip,
          userAgent,
          payload: { family: err.family },
        });
      }
      throw err;
    }
  }

  /**
   * Si la contraseña cambió desde que se abrió la sesión (reset del admin, CLI,
   * invitación…), la sesión entera se cierra. Los tokens de antes de esta
   * versión no traen huella: se les apunta la actual.
   */
  private async assertSamePassword(
    rotated: RotatedRefresh,
    user: { id: string; email: string; tenantId: string; passwordHash: string },
    ip?: string,
    userAgent?: string,
  ): Promise<void> {
    const current = passwordFingerprint(user.passwordHash);
    if (!rotated.pwdFp) {
      await this.refreshTokens.stampFingerprint(rotated.token, current);
      return;
    }
    if (rotated.pwdFp === current) return;

    await this.refreshTokens.revokeFamily(rotated.family);
    await this.audit.log({
      action: 'auth.refresh.password_changed',
      actorId: user.id,
      actorEmail: user.email,
      tenantId: user.tenantId,
      ip,
      userAgent,
    });
    throw new UnauthorizedException('Tu contraseña ha cambiado: vuelve a iniciar sesión');
  }

  /**
   * Super-admin: la 2FA es obligatoria. Una sesión que no entró con ella (de
   * antes, o abierta antes de ser super-admin) o cuya 2FA se quitó después se
   * cierra: vuelve a entrar (y, sin 2FA, la activa en el login).
   */
  private async assertSuperAdminTwoFactor(
    family: string,
    user: { id: string; email: string; tenantId: string; isSuperAdmin: boolean },
    ip?: string,
    userAgent?: string,
  ): Promise<void> {
    if (!user.isSuperAdmin) return;
    if ((await this.refreshTokens.hasTwoFactor(family)) && (await this.totp.isEnabled(user.id))) return;
    await this.refreshTokens.revokeFamily(family);
    await this.audit.log({
      action: 'auth.refresh.two_factor_required',
      actorId: user.id,
      actorEmail: user.email,
      tenantId: user.tenantId,
      ip,
      userAgent,
    });
    throw new UnauthorizedException(MSG_SUPERADMIN_RELOGIN);
  }

  /**
   * Super-admin only: cambia el tenant activo del JWT.
   * Emite un nuevo access token con tenantId destino. El refresh token
   * permanece el mismo (sigue ligado al user original); la sesión (sid)
   * recuerda el local elegido y los refrescos lo mantienen sin volver a
   * pedir nada.
   *
   * Si el user no es super admin → 403.
   * Sin sesión viva (sid sin refresh vivo, cerrada, revocada o de más de 90
   * días) → 401. El token nuevo caduca cuando el de entrada (no se alarga).
   * Otro local que el suyo: si la sesión se abrió con la 2FA (login en dos
   * pasos), sin código; si no (sesiones de antes), con el código 2FA como
   * antes (TOTP_REQUIRED / INVALID / LOCKED…). Sin 2FA activada, no se puede.
   * Si el venue destino no existe / está borrado → 404.
   */
  async switchTenant(
    userId: string,
    targetTenantId: string,
    opts: SwitchTenantOptions = {},
  ): Promise<{ accessToken: string; expiresIn: number; tenantId: string; venueSlug: string }> {
    const { ip, userAgent } = opts;
    // El super-admin pertenece a SU local: con otro local activo, el filtro por
    // local del middleware no lo encontraría (403/401). acrossVenues lo quita.
    const user = await this.prisma.acrossVenues((tx) =>
      tx.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          role: true,
          tenantId: true,
          isSuperAdmin: true,
          deletedAt: true,
        },
      }),
    );
    if (!user || user.deletedAt) {
      throw new UnauthorizedException('User disabled');
    }
    if (!user.isSuperAdmin) {
      throw new ForbiddenException('Solo super admins pueden cambiar de local');
    }
    // Un access token suelto (robado) no se renueva aquí: hace falta su sesión
    // viva (sin logout ni revocar, dentro de los 90 días) y el nuevo caduca
    // cuando el de entrada.
    const sessionId = await this.assertLiveSession(user.id, opts.sessionId);
    const expiresIn = remainingSeconds(opts.tokenExp);
    // Entrar como dueño en un local ajeno es lo mismo que la consola: con 2FA,
    // pedida una vez al entrar (login en dos pasos) y no en cada cambio.
    // Volver al suyo, no (el refresco ya se lo da).
    const otherVenue = targetTenantId !== user.tenantId;
    const twoFactor = otherVenue ? await this.switchTwoFactor(user.id, opts) : false;

    const venue = await this.prisma.asSystem((tx) =>
      tx.venue.findUnique({
        where: { id: targetTenantId },
        select: { id: true, slug: true, deletedAt: true },
      }),
    );
    if (!venue || venue.deletedAt) {
      throw new NotFoundException('Local destino no encontrado');
    }

    await this.refreshTokens.setActiveVenue(sessionId, otherVenue ? venue.id : null);

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      tenantId: venue.id,
      venueSlug: venue.slug,
      sid: sessionId,
    };
    const accessToken = await this.jwt.signAsync(payload, { expiresIn });

    await this.audit.log({
      action: 'auth.switch_tenant',
      actorId: user.id,
      actorEmail: user.email,
      tenantId: venue.id,
      ip,
      userAgent,
      payload: { fromUser: user.id, toVenue: venue.slug, twoFactor },
    });

    this.logger.log(`SUPER_ADMIN ${user.email} switched tenant to ${venue.slug}`);

    return {
      accessToken,
      expiresIn,
      tenantId: venue.id,
      venueSlug: venue.slug,
    };
  }

  /** La sesión del access token, viva y del mismo usuario; si no, 401 (el panel refresca o pide entrar). */
  private async assertLiveSession(userId: string, sessionId: string | undefined): Promise<string> {
    const session = sessionId ? await this.refreshTokens.liveSession(sessionId) : null;
    if (!sessionId || !session || session.userId !== userId) {
      throw new UnauthorizedException(MSG_SESSION_CLOSED);
    }
    return sessionId;
  }

  /**
   * 2FA para entrar en otro local: la del login si la sesión entró con ella
   * (y la sigue teniendo activada); si no, el código ahora.
   */
  private async switchTwoFactor(userId: string, opts: SwitchTenantOptions): Promise<'login' | 'code'> {
    const verified = opts.sessionId ? await this.refreshTokens.hasTwoFactor(opts.sessionId) : false;
    if (verified && (await this.totp.isEnabled(userId))) return 'login';
    await this.totp.assertForUser(userId, opts.totpCode);
    return 'code';
  }

  /**
   * Revoca un refresh token (logout). Basta el refresh token (el access token
   * puede estar caducado). Idempotente — no falla si ya estaba revocado.
   */
  async logout(refreshToken: string, ip?: string, userAgent?: string): Promise<void> {
    const session = await this.refreshTokens.revoke(refreshToken);
    if (!session) return;
    await this.audit.log({
      action: 'auth.logout',
      actorId: session.userId,
      tenantId: session.tenantId,
      ip,
      userAgent,
    });
  }
}
