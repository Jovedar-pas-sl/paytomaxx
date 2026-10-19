import { ForbiddenException, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { readCookie } from '../../common/http/cookies';
import { parseCorsOrigins } from '../../common/http/cors';
import { authBodyRefreshUntil } from '../../config/auth-body-refresh';
import { cutoffOpen } from '../../config/date-cutoff';
import { MetricsService } from '../metrics/metrics.service';
import {
  checkCookieCsrf,
  clearedRefreshCookie,
  hasStaffClientHeader,
  refreshCookie,
  refreshCookieName,
  type CookieSessionPolicy,
} from './session-cookie';

/**
 * Cómo viaja el refresh token entre el API y cada app (ver session-cookie.ts):
 *   - cookie: app nueva (cabecera X-OxioPay-Client y Origin permitido), el
 *     token va solo en la cookie HttpOnly de esa app;
 *   - legacy: app antigua en caché, el token va en el cuerpo, solo hasta
 *     AUTH_BODY_REFRESH_UNTIL (config/auth-body-refresh.ts).
 */
export type StaffClient = { readonly kind: 'cookie'; readonly cookieName: string } | { readonly kind: 'legacy' };

type BodyRoute = 'login' | 'refresh' | 'logout';

const MSG_FORBIDDEN_ORIGIN = 'Petición no permitida: ábrela desde la app de OxioPay.';
const MSG_NO_SESSION = 'Sesión caducada: vuelve a iniciar sesión';

@Injectable()
export class StaffSessionTransport {
  private readonly logger = new Logger(StaffSessionTransport.name);
  private readonly policy: CookieSessionPolicy;
  private readonly bodyRefreshUntil: Date | null;
  private readonly metrics: MetricsService;

  constructor(@Inject(ConfigService) config: ConfigService, @Inject(MetricsService) metrics: MetricsService) {
    this.metrics = metrics;
    this.policy = {
      allowedOrigins: parseCorsOrigins(config.get<string>('CORS_ORIGINS')),
      isProd: config.get<string>('NODE_ENV') === 'production',
    };
    this.bodyRefreshUntil = authBodyRefreshUntil(config.get<string>('AUTH_BODY_REFRESH_UNTIL'));
  }

  /** Login: con la cabecera propia pone la cookie (Origin permitido o 403); sin ella, app antigua. */
  loginClient(req: FastifyRequest): StaffClient {
    return hasStaffClientHeader(req.headers) ? this.cookieClient(req) : { kind: 'legacy' };
  }

  /** Refresh/logout: solo es app antigua el token en el cuerpo SIN la cabecera; todo lo demás usa la cookie. */
  sessionClient(req: FastifyRequest, bodyToken: string | undefined): StaffClient {
    if (bodyToken && !hasStaffClientHeader(req.headers)) return { kind: 'legacy' };
    return this.cookieClient(req);
  }

  /**
   * El refresh token a rotar: el del cuerpo mientras esa vía siga abierta (app
   * antigua, o la nueva pasando a la cookie la sesión que guardaba la
   * antigua); si no, el de la cookie. Sin ninguno, 401.
   */
  refreshTokenFor(client: StaffClient, req: FastifyRequest, bodyToken: string | undefined): string {
    if (bodyToken) {
      if (this.bodyRefreshAllowed('refresh', client)) return bodyToken;
      if (client.kind === 'legacy') throw new UnauthorizedException(MSG_NO_SESSION);
    }
    const fromCookie = this.cookieToken(client, req);
    if (!fromCookie) throw new UnauthorizedException(MSG_NO_SESSION);
    return fromCookie;
  }

  /** Logout: los tokens a revocar. El del cuerpo se acepta siempre (solo cierra una sesión). */
  logoutTokens(client: StaffClient, req: FastifyRequest, bodyToken: string | undefined): string[] {
    const tokens: string[] = [];
    if (bodyToken) {
      this.countBody('logout', client, true);
      tokens.push(bodyToken);
    }
    const fromCookie = this.cookieToken(client, req);
    if (fromCookie && fromCookie !== bodyToken) tokens.push(fromCookie);
    return tokens;
  }

  /**
   * Respuesta de login/refresh. Con cookie, el refresh token va solo en el
   * Set-Cookie (el cuerpo no lo lleva). A la app antigua, en el cuerpo: en el
   * refresco ya se comprobó la fecha; en el login, aquí.
   */
  deliver<T extends { refreshToken: string; refreshExpiresIn: number }>(
    client: StaffClient,
    route: 'login' | 'refresh',
    result: T,
    reply: FastifyReply,
  ): Omit<T, 'refreshToken'> & { refreshToken?: string } {
    const { refreshToken, ...rest } = result;
    if (client.kind === 'cookie') {
      reply.header('Set-Cookie', refreshCookie(client.cookieName, refreshToken, result.refreshExpiresIn, this.policy.isProd));
      return rest;
    }
    if (route === 'login' && !this.bodyRefreshAllowed('login', client)) return rest;
    return { ...rest, refreshToken };
  }

  /** Borra la cookie de esa app (logout, o un refresco que ya no vale). */
  clearCookie(client: StaffClient, reply: FastifyReply): void {
    if (client.kind === 'cookie') reply.header('Set-Cookie', clearedRefreshCookie(client.cookieName, this.policy.isProd));
  }

  private cookieClient(req: FastifyRequest): StaffClient {
    const check = checkCookieCsrf(req.headers, this.policy);
    if (!check.ok) {
      this.logger.warn(`Sesión con cookie rechazada (${check.reason}) desde ${String(req.headers.origin ?? 'sin Origin')}`);
      throw new ForbiddenException(MSG_FORBIDDEN_ORIGIN);
    }
    return { kind: 'cookie', cookieName: refreshCookieName(check.origin) };
  }

  private cookieToken(client: StaffClient, req: FastifyRequest): string | null {
    if (client.kind !== 'cookie') return null;
    const value = readCookie(req.headers.cookie, client.cookieName);
    return value ? value : null;
  }

  private bodyRefreshAllowed(route: BodyRoute, client: StaffClient): boolean {
    const open = cutoffOpen(this.bodyRefreshUntil);
    this.countBody(route, client, open);
    return open;
  }

  private countBody(route: BodyRoute, client: StaffClient, allowed: boolean): void {
    this.metrics.authBodyRefresh.inc({
      route,
      client: client.kind === 'legacy' ? 'legacy' : 'migration',
      result: allowed ? 'allowed' : 'closed',
    });
  }
}
