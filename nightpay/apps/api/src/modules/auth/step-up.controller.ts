import { Body, Controller, Get, Header, Headers, HttpCode, Inject, Post, UnauthorizedException } from '@nestjs/common';
import {
  StepUpPasskeyOptionsSchema,
  StepUpPasskeySchema,
  StepUpTotpSchema,
  type JwtPayload,
  type StepUpPasskeyDto,
  type StepUpPasskeyOptionsDto,
  type StepUpPasskeyResult,
  type StepUpStatus,
  type StepUpTotpDto,
} from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { StepUpService, type StepUpActor } from './step-up.service';

/**
 * La verificación del momento del personal (ver lo delicado de un cobro):
 *   GET  /v1/auth/step-up       → si está verificado, hasta cuándo y con qué tiene que verificarse.
 *   POST /v1/auth/step-up/totp  { code } → con el código de su 2FA: 5 minutos.
 *   POST /v1/auth/step-up/passkey/options { action? } → el reto para su llave (quien no tiene 2FA).
 *   POST /v1/auth/step-up/passkey { response, action? } → sin `action`, 5 minutos para ver;
 *        con ella, la prueba de un solo uso (2 min) para repetir esa acción (cabecera X-Step-Up-Token).
 * Errores: 403 sin 2FA, código malo o usado, o sesión sin `sid`; 429 demasiados códigos;
 * con la llave, 403 TOTP_REQUIRED (tiene 2FA: con su código) o PASSKEY_NOT_SET (sin llave).
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

  @Post('passkey/options')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'auth-step-up' })
  passkeyOptions(
    @CurrentUser() user: JwtPayload | undefined,
    @Body(new ZodValidationPipe(StepUpPasskeyOptionsSchema)) body: StepUpPasskeyOptionsDto,
    @Headers('origin') origin: string | undefined,
  ): Promise<unknown> {
    return this.stepUp.passkeyOptions(stepUpActorOf(user), body.action, origin);
  }

  @Post('passkey')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'auth-step-up' })
  verifyPasskey(
    @CurrentUser() user: JwtPayload | undefined,
    @Body(new ZodValidationPipe(StepUpPasskeySchema)) body: StepUpPasskeyDto,
    @Headers('origin') origin: string | undefined,
  ): Promise<StepUpPasskeyResult> {
    return this.stepUp.verifyWithPasskey(stepUpActorOf(user), body.response, body.action, origin);
  }
}

/** Quien pide, con su sesión (`sid`): la verificación va atada a ella. */
export function stepUpActorOf(user: JwtPayload | undefined): StepUpActor {
  if (!user?.sub) throw new UnauthorizedException('No autenticado');
  return { userId: user.sub, sessionId: user.sid ?? null, tenantId: user.tenantId, email: user.email };
}
