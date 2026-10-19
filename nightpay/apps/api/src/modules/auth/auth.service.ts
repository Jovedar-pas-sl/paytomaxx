import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
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
import type { JwtPayload, LoginRequest, LoginResponse, RefreshResponse } from '@nightpay/contracts';

const BCRYPT_ROUNDS = 10;
// 1 h: el refresco (automático en las apps) comprueba que el usuario sigue
// activo, así que una baja o un cambio de contraseña cortan el acceso en 1 h.
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
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

type LoginUser = Prisma.UserGetPayload<{ include: { venue: true } }>;

/** Lo que emite el servicio: siempre con el refresh token (el controlador decide si va en cookie o en el cuerpo). */
export type IssuedLogin = LoginResponse & { refreshToken: string };
export type IssuedRefresh = RefreshResponse & { refreshToken: string };

export interface SwitchTenantOptions {
  /** Código 2FA: obligatorio para entrar en un local que no es el suyo. */
  totpCode?: string;
  /** sid del access token: la sesión que recuerda el local elegido. */
  sessionId?: string;
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

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(JwtService) jwt: JwtService,
    @Inject(LockoutService) lockout: LockoutService,
    @Inject(AuditService) audit: AuditService,
    @Inject(MetricsService) metrics: MetricsService,
    @Inject(RefreshTokenService) refreshTokens: RefreshTokenService,
    @Inject(TotpService) totp: TotpService,
  ) {
    this.prisma = prisma;
    this.jwt = jwt;
    this.lockout = lockout;
    this.audit = audit;
    this.metrics = metrics;
    this.refreshTokens = refreshTokens;
    this.totp = totp;
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

    const refresh = await this.refreshTokens.issue(user.id, user.tenantId, {
      pwdFp: passwordFingerprint(user.passwordHash),
    });

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
   * Super-admin only: cambia el tenant activo del JWT.
   * Emite un nuevo access token con tenantId destino. El refresh token
   * permanece el mismo (sigue ligado al user original); la sesión (sid)
   * recuerda el local elegido y los refrescos lo mantienen sin volver a
   * pedir nada.
   *
   * Si el user no es super admin → 403.
   * Otro local que el suyo → código 2FA (TOTP_REQUIRED / INVALID / LOCKED…).
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
    // Entrar como dueño en un local ajeno es lo mismo que la consola: con 2FA.
    // Volver al suyo, no (el refresco ya se lo da).
    const otherVenue = targetTenantId !== user.tenantId;
    if (otherVenue) await this.totp.assertForUser(user.id, opts.totpCode);

    const venue = await this.prisma.asSystem((tx) =>
      tx.venue.findUnique({
        where: { id: targetTenantId },
        select: { id: true, slug: true, deletedAt: true },
      }),
    );
    if (!venue || venue.deletedAt) {
      throw new NotFoundException('Local destino no encontrado');
    }

    if (opts.sessionId) await this.refreshTokens.setActiveVenue(opts.sessionId, otherVenue ? venue.id : null);

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      tenantId: venue.id,
      venueSlug: venue.slug,
      ...(opts.sessionId ? { sid: opts.sessionId } : {}),
    };
    const accessToken = await this.jwt.signAsync(payload, {
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    });

    await this.audit.log({
      action: 'auth.switch_tenant',
      actorId: user.id,
      actorEmail: user.email,
      tenantId: venue.id,
      ip,
      userAgent,
      payload: { fromUser: user.id, toVenue: venue.slug, twoFactor: otherVenue },
    });

    this.logger.log(`SUPER_ADMIN ${user.email} switched tenant to ${venue.slug}`);

    return {
      accessToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      tenantId: venue.id,
      venueSlug: venue.slug,
    };
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
