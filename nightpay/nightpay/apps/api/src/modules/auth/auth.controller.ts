import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
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
import { Public } from '../../common/decorators/public.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { AuthService } from './auth.service';
import type { RequestContext } from '../../common/context/request-context';
import { ClsService } from 'nestjs-cls';

function extractIp(req: FastifyRequest): string | undefined {
  const xff = req.headers['x-forwarded-for'];
  const ipHeader = Array.isArray(xff) ? xff[0] : xff;
  return ((ipHeader as string | undefined) ?? req.ip)?.split(',')[0]?.trim();
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
  async login(
    @Body(new ZodValidationPipe(LoginRequestSchema)) body: LoginRequest,
    @Req() req: FastifyRequest,
  ): Promise<LoginResponse> {
    const ip = extractIp(req);
    const userAgent = req.headers['user-agent'] as string | undefined;
    return this.auth.login(body, ip, userAgent);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Body(new ZodValidationPipe(RefreshRequestSchema)) body: RefreshRequest,
    @Req() req: FastifyRequest,
  ): Promise<RefreshResponse> {
    const ip = extractIp(req);
    const userAgent = req.headers['user-agent'] as string | undefined;
    return this.auth.refresh(body.refreshToken, ip, userAgent);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @Body(new ZodValidationPipe(LogoutRequestSchema)) body: LogoutRequest,
    @Req() req: FastifyRequest,
  ): Promise<void> {
    const ip = extractIp(req);
    const userAgent = req.headers['user-agent'] as string | undefined;
    const ctx = this.cls.get('ctx');
    await this.auth.logout(body.refreshToken, ctx?.userId, ctx?.tenantId, ip, userAgent);
  }
}
