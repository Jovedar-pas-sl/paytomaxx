import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { LoginRequestSchema, type LoginRequest, type LoginResponse } from '@nightpay/contracts';
import { Public } from '../../common/decorators/public.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  private readonly auth: AuthService;
  constructor(@Inject(AuthService) auth: AuthService) {
    this.auth = auth;
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(LoginRequestSchema)) body: LoginRequest,
    @Req() req: FastifyRequest,
  ): Promise<LoginResponse> {
    const xff = req.headers['x-forwarded-for'];
    const ipHeader = Array.isArray(xff) ? xff[0] : xff;
    const ip = ((ipHeader as string | undefined) ?? req.ip)?.split(',')[0]?.trim();
    const userAgent = req.headers['user-agent'] as string | undefined;
    return this.auth.login(body, ip, userAgent);
  }
}
