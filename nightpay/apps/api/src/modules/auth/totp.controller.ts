import { Body, Controller, Get, Header, HttpCode, Inject, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  TotpCodeRequestSchema,
  type JwtPayload,
  type TotpCodeRequest,
  type TotpSetupResponse,
  type TotpStatusResponse,
} from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { IpRateLimit, clientIp } from '../../common/guards/ip-rate-limit.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { TotpEnrollmentService, type ClientMeta } from './totp-enrollment.service';

const MAX_USER_AGENT_LENGTH = 512;

/**
 * La 2FA de cada uno, desde su app (cualquier usuario con sesión):
 *   GET  /v1/auth/totp          → { enabled }
 *   POST /v1/auth/totp/setup    → { otpauthUrl, secret, qrPngDataUrl }  (409 si ya está activada)
 *   POST /v1/auth/totp/confirm  { code } → { enabled: true }
 *   POST /v1/auth/totp/disable  { code } → { enabled: false }
 * Errores: 403 código malo o repetido, 409 estado (ya activada, no activada,
 * nada pendiente), 429 demasiados códigos malos, 422 código mal escrito.
 */
@Controller('auth/totp')
export class TotpController {
  private readonly enrollment: TotpEnrollmentService;

  constructor(@Inject(TotpEnrollmentService) enrollment: TotpEnrollmentService) {
    this.enrollment = enrollment;
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  status(@CurrentUser() user: JwtPayload | undefined): Promise<TotpStatusResponse> {
    return this.enrollment.status(requireUserId(user));
  }

  @Post('setup')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 10, windowSec: 60, scope: 'auth-totp-setup' })
  setup(@CurrentUser() user: JwtPayload | undefined): Promise<TotpSetupResponse> {
    return this.enrollment.setup(requireUserId(user));
  }

  @Post('confirm')
  @HttpCode(200)
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'auth-totp' })
  confirm(
    @CurrentUser() user: JwtPayload | undefined,
    @Body(new ZodValidationPipe(TotpCodeRequestSchema)) body: TotpCodeRequest,
    @Req() req: FastifyRequest,
  ): Promise<{ enabled: true }> {
    return this.enrollment.confirm(requireUserId(user), body.code, clientMeta(req));
  }

  @Post('disable')
  @HttpCode(200)
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'auth-totp' })
  disable(
    @CurrentUser() user: JwtPayload | undefined,
    @Body(new ZodValidationPipe(TotpCodeRequestSchema)) body: TotpCodeRequest,
    @Req() req: FastifyRequest,
  ): Promise<{ enabled: false }> {
    return this.enrollment.disable(requireUserId(user), body.code, clientMeta(req));
  }
}

/** El AuthGuard global ya exige sesión; esto es por si acaso. */
function requireUserId(user: JwtPayload | undefined): string {
  if (!user?.sub) throw new UnauthorizedException('No autenticado');
  return user.sub;
}

function clientMeta(req: FastifyRequest): ClientMeta {
  const ua = req.headers['user-agent'];
  return {
    ip: clientIp(req) ?? undefined,
    userAgent: typeof ua === 'string' ? ua.slice(0, MAX_USER_AGENT_LENGTH) : undefined,
  };
}
