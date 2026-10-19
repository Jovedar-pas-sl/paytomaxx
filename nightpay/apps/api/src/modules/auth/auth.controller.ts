import { Body, Controller, HttpCode, HttpException, HttpStatus, Inject, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  LoginRequestSchema,
  LoginTotpRequestSchema,
  LogoutRequestSchema,
  RefreshRequestSchema,
  type JwtPayload,
  type LoginRequest,
  type LoginResponse,
  type LoginTotpRequest,
  type LogoutRequest,
  type RefreshRequest,
  type RefreshResponse,
} from '@nightpay/contracts';

const SwitchTenantRequestSchema = z.object({
  tenantId: z.string().uuid(),
  /** Código 2FA: solo si la sesión no entró con la 2FA (sesiones de antes del login en dos pasos). */
  totpCode: z.string().regex(/^\d{6}$/, 'El código 2FA son 6 cifras').optional(),
});
type SwitchTenantBody = z.infer<typeof SwitchTenantRequestSchema>;
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { IpRateLimit, clientIp } from '../../common/guards/ip-rate-limit.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { AuthService } from './auth.service';
import { StaffSessionTransport } from './staff-session.transport';
import type { RequestContext } from '../../common/context/request-context';
import { ClsService } from 'nestjs-cls';

const MAX_USER_AGENT_LENGTH = 512;

// La IP real (CF-Connecting-IP detrás de Cloudflare), la misma que el límite de peticiones.
function extractIp(req: FastifyRequest): string | undefined {
  return clientIp(req) ?? undefined;
}

// Lo manda el cliente y acaba en el audit: recortado.
function extractUserAgent(req: FastifyRequest): string | undefined {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua.slice(0, MAX_USER_AGENT_LENGTH) : undefined;
}

/**
 * Sesión del personal. El refresh token va en una cookie HttpOnly por app
 * (ver session-cookie.ts y staff-session.transport.ts); las apps antiguas en
 * caché lo mandan en el cuerpo hasta AUTH_BODY_REFRESH_UNTIL.
 */
@Controller('auth')
export class AuthController {
  private readonly auth: AuthService;
  private readonly cls: ClsService<{ ctx: RequestContext }>;
  private readonly sessions: StaffSessionTransport;

  constructor(
    @Inject(AuthService) auth: AuthService,
    @Inject(ClsService) cls: ClsService<{ ctx: RequestContext }>,
    @Inject(StaffSessionTransport) sessions: StaffSessionTransport,
  ) {
    this.auth = auth;
    this.cls = cls;
    this.sessions = sessions;
  }

  /** App nueva (X-OxioPay-Client): Set-Cookie y sin refreshToken en el cuerpo. App antigua: en el cuerpo. */
  @Public()
  @Post('login')
  @HttpCode(200)
  @IpRateLimit({ max: 10, windowSec: 60, scope: 'auth-login' })
  async login(
    @Body(new ZodValidationPipe(LoginRequestSchema)) body: LoginRequest,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LoginResponse> {
    // Antes de mirar la contraseña: un Origin que no vale no llega a bcrypt.
    const client = this.sessions.loginClient(req);
    const result = await this.auth.login(body, extractIp(req), extractUserAgent(req));
    return this.sessions.deliver(client, 'login', result, reply);
  }

  /**
   * Segundo paso del login del super-admin con 2FA: el ticket que dio la
   * contraseña (401 TOTP_REQUIRED) y el código. Abre la sesión como el login
   * (cookie HttpOnly o, app antigua, en el cuerpo).
   */
  @Public()
  @Post('login/totp')
  @HttpCode(200)
  @IpRateLimit({ max: 10, windowSec: 60, scope: 'auth-login-totp' })
  async loginTotp(
    @Body(new ZodValidationPipe(LoginTotpRequestSchema)) body: LoginTotpRequest,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LoginResponse> {
    const client = this.sessions.loginClient(req);
    const result = await this.auth.loginWithTotp(body.loginTicket, body.totpCode, extractIp(req), extractUserAgent(req));
    return this.sessions.deliver(client, 'login', result, reply);
  }

  /**
   * Access token nuevo con la cookie (y la cookie rotada). Las apps lo piden
   * al abrirse: el access token solo vive en la memoria de cada pestaña. Con
   * cada carga de pestaña hay un refresco: más margen por IP que antes (varios
   * móviles del local salen por la misma IP).
   */
  @Public()
  @Post('refresh')
  @HttpCode(200)
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'auth-refresh' })
  async refresh(
    @Body(new ZodValidationPipe(RefreshRequestSchema.optional())) body: RefreshRequest | undefined,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<RefreshResponse> {
    const client = this.sessions.sessionClient(req, body?.refreshToken);
    try {
      const token = this.sessions.refreshTokenFor(client, req, body?.refreshToken);
      const result = await this.auth.refresh(token, extractIp(req), extractUserAgent(req));
      return this.sessions.deliver(client, 'refresh', result, reply);
    } catch (err) {
      // Sesión que ya no vale (caducada, revocada, reusada): fuera también la cookie.
      if (isUnauthorized(err)) this.sessions.clearCookie(client, reply);
      throw err;
    }
  }

  /**
   * Pública a propósito: basta la cookie (o, en las apps antiguas, el refresh
   * token del cuerpo); el access token puede estar caducado. Así cerrar sesión
   * revoca el refresh aunque haya pasado la hora del access token. Borra la cookie.
   */
  @Public()
  @Post('logout')
  @HttpCode(204)
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'auth-logout' })
  async logout(
    @Body(new ZodValidationPipe(LogoutRequestSchema.optional())) body: LogoutRequest | undefined,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const client = this.sessions.sessionClient(req, body?.refreshToken);
    for (const token of this.sessions.logoutTokens(client, req, body?.refreshToken)) {
      await this.auth.logout(token, extractIp(req), extractUserAgent(req));
    }
    this.sessions.clearCookie(client, reply);
  }

  /**
   * Super-admin only: cambia el tenant activo del JWT. A otro local que el
   * suyo, con la 2FA del login (o, en sesiones sin ella, el código). El frontend usa el nuevo
   * accessToken y recarga la app. Va con el access token (Authorization), no
   * con la cookie: no necesita la protección CSRF.
   */
  @Post('switch-tenant')
  @HttpCode(200)
  @IpRateLimit({ max: 10, windowSec: 60, scope: 'auth-switch-tenant' })
  async switchTenant(
    @Body(new ZodValidationPipe(SwitchTenantRequestSchema)) body: SwitchTenantBody,
    @CurrentUser() user: JwtPayload | undefined,
    @Req() req: FastifyRequest,
  ): Promise<{ accessToken: string; expiresIn: number; tenantId: string; venueSlug: string }> {
    const ctx = this.cls.get('ctx');
    if (!ctx?.userId) {
      throw new UnauthorizedException('No autenticado');
    }
    return this.auth.switchTenant(ctx.userId, body.tenantId, {
      totpCode: body.totpCode,
      sessionId: user?.sid,
      ip: extractIp(req),
      userAgent: extractUserAgent(req),
    });
  }
}

function isUnauthorized(err: unknown): boolean {
  return err instanceof HttpException && err.getStatus() === HttpStatus.UNAUTHORIZED;
}
