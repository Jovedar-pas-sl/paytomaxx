import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
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
  ): Promise<LoginResponse> {
    return this.auth.login(body);
  }
}
