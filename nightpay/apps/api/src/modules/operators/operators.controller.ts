import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  AcceptInviteSchema,
  type AcceptInviteDto,
  type EarningView,
  type OperatorBalance,
  type PayoutView,
} from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import type { JwtPayload } from '@nightpay/contracts';
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
    return this.operators.getBalance(user.sub);
  }

  @Get('me/earnings')
  @UseGuards(RolesGuard)
  @Roles('OPERATOR')
  async myEarnings(@CurrentUser() user: JwtPayload): Promise<EarningView[]> {
    return this.operators.getMyEarnings(user.sub);
  }

  @Get('me/payments')
  @UseGuards(RolesGuard)
  @Roles('OPERATOR')
  async myPayments(@CurrentUser() user: JwtPayload) {
    return this.operators.getMyPayments(user.sub);
  }

  @Get('me/payouts')
  @UseGuards(RolesGuard)
  @Roles('OPERATOR')
  async myPayouts(@CurrentUser() user: JwtPayload): Promise<PayoutView[]> {
    return this.operators.getMyPayouts(user.sub);
  }

  /**
   * Endpoint público — la operadora acepta la invitación con su token JWT
   * (TTL 24h) y setea su password por primera vez. Token de un solo uso.
   */
  @Public()
  @Post('accept-invite')
  @HttpCode(200)
  async acceptInvite(
    @Body(new ZodValidationPipe(AcceptInviteSchema)) dto: AcceptInviteDto,
  ): Promise<{ ok: true }> {
    return this.operators.acceptInvite(dto.token, dto.password);
  }
}
