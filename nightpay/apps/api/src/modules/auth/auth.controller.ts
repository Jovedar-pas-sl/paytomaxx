import { Body, Controller, HttpCode, Inject, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  LoginRequestSchema,
  LogoutRequestSchema,
  RefreshRequestSchema,
  type LoginRequest,
  type LoginResponse,
  type LogoutRequest,
  type RefreshRequest,
  type RefreshResponse,
} from '@nightpay/contracts';

const SwitchTenantRequestSchema = z.object({
  tenantId: z.string().uuid(),
});
import { Public } from '../../common/decorators/public.decorator';
import { IpRateLimit, clientIp } from '../../common/guards/ip-rate-limit.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { AuthService } from './auth.service';
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

@Controller('auth')
export class AuthController {
  private readonly auth: AuthService;
  private readonly cls: ClsService<{ ctx: RequestContext }>;

  constructor(
    @Inject(AuthService) auth: AuthService,
    @Inject(ClsService) cls: ClsService<{ ctx: RequestContext }>,
  ) {
    this.auth = auth;
    this.cls = cls;
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @IpRateLimit({ max: 10, windowSec: 60, scope: 'auth-login' })
  async login(
    @Body(new ZodValidationPipe(LoginRequestSchema)) body: LoginRequest,
    @Req() req: FastifyRequest,
  ): Promise<LoginResponse> {
    const ip = extractIp(req);
    const userAgent = extractUserAgent(req);
    return this.auth.login(body, ip, userAgent);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'auth-refresh' })
  async refresh(
    @Body(new ZodValidationPipe(RefreshRequestSchema)) body: RefreshRequest,
    @Req() req: FastifyRequest,
  ): Promise<RefreshResponse> {
    const ip = extractIp(req);
    const userAgent = extractUserAgent(req);
    return this.auth.refresh(body.refreshToken, ip, userAgent);
  }

  /**
   * Pública a propósito: basta el refresh token (las apps mandan también el
   * access token, que puede estar caducado; se ignora). Así cerrar sesión
   * revoca el refresh aunque haya pasado la hora del access token.
   */
  @Public()
  @Post('logout')
  @HttpCode(204)
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'auth-logout' })
  async logout(
    @Body(new ZodValidationPipe(LogoutRequestSchema)) body: LogoutRequest,
    @Req() req: FastifyRequest,
  ): Promise<void> {
    await this.auth.logout(body.refreshToken, extractIp(req), extractUserAgent(req));
  }

  /**
   * Super-admin only: cambia el tenant activo del JWT.
   * El frontend usa el nuevo accessToken y recarga la app.
   */
  @Post('switch-tenant')
  @HttpCode(200)
  async switchTenant(
    @Body(new ZodValidationPipe(SwitchTenantRequestSchema)) body: { tenantId: string },
    @Req() req: FastifyRequest,
  ): Promise<{ accessToken: string; expiresIn: number; tenantId: string; venueSlug: string }> {
    const ctx = this.cls.get('ctx');
    if (!ctx?.userId) {
      throw new UnauthorizedException('No autenticado');
    }
    const ip = extractIp(req);
    const userAgent = extractUserAgent(req);
    return this.auth.switchTenant(ctx.userId, body.tenantId, ip, userAgent);
  }
}
