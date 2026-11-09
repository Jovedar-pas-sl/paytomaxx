import { Body, Controller, Get, Header, HttpCode, Inject, Post, UnauthorizedException } from '@nestjs/common';
import { StepUpTotpSchema, type JwtPayload, type StepUpStatus, type StepUpTotpDto } from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { StepUpService, type StepUpActor } from './step-up.service';

/**
 * La verificación del momento del personal (ver lo delicado de un cobro):
 *   GET  /v1/auth/step-up       → si está verificado, hasta cuándo y con qué tiene que verificarse.
 *   POST /v1/auth/step-up/totp  { code } → con el código de su 2FA: 5 minutos.
 * Errores: 403 sin 2FA, código malo o usado, o sesión sin `sid`; 429 demasiados códigos.
 */
@Controller('auth/step-up')
export class StepUpController {
  private readonly stepUp: StepUpService;

  constructor(@Inject(StepUpService) stepUp: StepUpService) {
    this.stepUp = stepUp;
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  status(@CurrentUser() user: JwtPayload | undefined): Promise<StepUpStatus> {
    return this.stepUp.status(stepUpActorOf(user));
  }

  @Post('totp')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'auth-step-up' })
  verifyTotp(
    @CurrentUser() user: JwtPayload | undefined,
    @Body(new ZodValidationPipe(StepUpTotpSchema)) body: StepUpTotpDto,
  ): Promise<StepUpStatus> {
    return this.stepUp.verifyWithTotp(stepUpActorOf(user), body.code);
  }
}

/** Quien pide, con su sesión (`sid`): la verificación va atada a ella. */
export function stepUpActorOf(user: JwtPayload | undefined): StepUpActor {
  if (!user?.sub) throw new UnauthorizedException('No autenticado');
  return { userId: user.sub, sessionId: user.sid ?? null, tenantId: user.tenantId, email: user.email };
}
