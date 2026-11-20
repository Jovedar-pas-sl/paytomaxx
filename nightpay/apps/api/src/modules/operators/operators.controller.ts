import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  AcceptInviteSchema,
  SelfOnboardingSubmitSchema,
  type AcceptInviteDto,
  type EarningView,
  type OperatorBalance,
  type OxiocardView,
  type PayoutAccountNotice,
  type PayoutView,
  type SelfOnboardingProfile,
  type SelfOnboardingSubmitDto,
} from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import type { JwtPayload } from '@nightpay/contracts';
import type { MyPayoutInfo } from './my-payout-info';
import { OperatorsService } from './operators.service';

/**
 * Endpoints self-service para la operadora.
 * Path: /operators/me/* (autenticado, role=OPERATOR)
 *       /operators/accept-invite (público, set-password)
 */
@Controller('operators')
export class OperatorsController {
  private readonly operators: OperatorsService;

  constructor(@Inject(OperatorsService) operators: OperatorsService) {
    this.operators = operators;
  }

  @Get('me/balance')
  @UseGuards(RolesGuard)
  @Roles('OPERATOR')
  async myBalance(@CurrentUser() user: JwtPayload): Promise<OperatorBalance> {
    return this.operators.getBalance(user.sub, user.tenantId);
  }

  @Get('me/earnings')
  @UseGuards(RolesGuard)
  @Roles('OPERATOR')
  async myEarnings(@CurrentUser() user: JwtPayload): Promise<EarningView[]> {
    return this.operators.getMyEarnings(user.sub, user.tenantId);
  }

  @Get('me/payments')
  @UseGuards(RolesGuard)
  @Roles('OPERATOR')
  async myPayments(@CurrentUser() user: JwtPayload) {
    return this.operators.getMyPayments(user.sub, user.tenantId);
  }

  @Get('me/payouts')
  @UseGuards(RolesGuard)
  @Roles('OPERATOR')
  async myPayouts(@CurrentUser() user: JwtPayload): Promise<PayoutView[]> {
    return this.operators.getMyPayouts(user.sub, user.tenantId);
  }

  /** Días de espera, su cuenta de cobro (enmascarada) y sus deudas por devoluciones. */
  @Get('me/payout-info')
  @UseGuards(RolesGuard)
  @Roles('OPERATOR')
  async myPayoutInfo(@CurrentUser() user: JwtPayload): Promise<MyPayoutInfo> {
    return this.operators.getMyPayoutInfo(user.sub, user.tenantId);
  }

  /** «Tu cuenta de cobro ha cambiado» (tapada), hasta que lo da por visto; null si no hay. */
  @Get('me/payout-notice')
  @UseGuards(RolesGuard)
  @Roles('OPERATOR')
  async myPayoutNotice(@CurrentUser() user: JwtPayload): Promise<PayoutAccountNotice | null> {
    return this.operators.getPayoutNotice(user.sub, user.tenantId);
  }

  /** «Entendido»: el aviso de la cuenta de cobro queda visto. */
  @Post('me/payout-notice/seen')
  @UseGuards(RolesGuard)
  @Roles('OPERATOR')
  @HttpCode(200)
  async seenPayoutNotice(@CurrentUser() user: JwtPayload): Promise<{ ok: true }> {
    return this.operators.markPayoutNoticeSeen(user.sub, user.tenantId);
  }

  /** «Abrir mi OxioCard»: solo apunta la petición (sin OXIOCARD_ENABLED, 404). */
  @Post('me/oxiocard')
  @UseGuards(RolesGuard)
  @Roles('OPERATOR')
  @HttpCode(200)
  async requestOxiocard(@CurrentUser() user: JwtPayload): Promise<OxiocardView> {
    return this.operators.requestMyOxiocard(user.sub, user.tenantId);
  }

  /**
   * Endpoint público — la operadora acepta la invitación con su token JWT
   * (TTL 24h) y setea su password por primera vez. Token de un solo uso.
   */
  @Public()
  @Post('accept-invite')
  @HttpCode(200)
  @IpRateLimit({ max: 10, windowSec: 60, scope: 'operators-invite' })
  async acceptInvite(
    @Body(new ZodValidationPipe(AcceptInviteSchema)) dto: AcceptInviteDto,
  ): Promise<{ ok: true }> {
    return this.operators.acceptInvite(dto.token, dto.password, dto.birthDate);
  }

  /**
   * Lee el perfil pre-rellenado para la chica que abre el link self-onboarding.
   * Sin auth (JWT en path es la cred). Rate-limit suave para evitar enumeración.
   */
  @Public()
  @Get('self-onboarding/:token')
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'operators-self-onboarding-get' })
  async getSelfOnboardingProfile(
    @Param('token') token: string,
  ): Promise<SelfOnboardingProfile> {
    return this.operators.getSelfOnboardingProfile(token);
  }

  /** La chica submite su perfil. */
  @Public()
  @Post('self-onboarding/:token')
  @HttpCode(200)
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'operators-self-onboarding-submit' })
  async submitSelfOnboarding(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(SelfOnboardingSubmitSchema)) dto: SelfOnboardingSubmitDto,
  ): Promise<{ ok: true; payoutIgnored?: 'existing' | 'owner_required'; minor?: true }> {
    return this.operators.submitSelfOnboarding(token, dto);
  }
}
