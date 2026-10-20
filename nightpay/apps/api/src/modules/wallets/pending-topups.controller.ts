import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import {
  PendingTopUpStartSchema,
  SaldoRefSchema,
  type AssignedTopUp,
  type CreatedPaymentResponse,
  type JwtPayload,
  type PendingTopUpStartDto,
  type PendingTopUpView,
  type SaldoRefDto,
} from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { PendingTopUpService } from './wallet-pending-topup.service';

/**
 * Recargas pendientes de asignar (plan B de «Recargar saldo» en Inicio):
 *  - POST /v1/reception/topups/pending          → cobrar primero (tarjeta, el QR en su móvil) sin su NFC.
 *  - GET  /v1/reception/topups/pending          → las cobradas que esperan su saldo (la chica, las suyas).
 *  - POST /v1/reception/topups/:walletId/assign → su NFC o su código: se suma a su saldo.
 * Desde Inicio (también la chica), Recepción o el panel (Clientes → Saldos).
 */
@Controller('reception/topups')
@UseGuards(RolesGuard)
export class PendingTopUpsController {
  private readonly pending: PendingTopUpService;

  constructor(@Inject(PendingTopUpService) pending: PendingTopUpService) {
    this.pending = pending;
  }

  @Post('pending')
  @HttpCode(201)
  @Roles('OPERATOR', 'WAITER', 'MANAGER', 'OWNER')
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'reception-pending' })
  async start(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(PendingTopUpStartSchema)) body: PendingTopUpStartDto,
  ): Promise<CreatedPaymentResponse> {
    return this.pending.start(actorOf(user), body);
  }

  @Get('pending')
  @Roles('OPERATOR', 'WAITER', 'MANAGER', 'OWNER')
  async list(@CurrentUser() user: JwtPayload): Promise<PendingTopUpView[]> {
    return this.pending.list(actorOf(user));
  }

  @Post(':walletId/assign')
  @HttpCode(200)
  @Roles('OPERATOR', 'WAITER', 'MANAGER', 'OWNER')
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'wallet-lookup' })
  async assign(
    @CurrentUser() user: JwtPayload,
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Body(new ZodValidationPipe(SaldoRefSchema)) body: SaldoRefDto,
  ): Promise<AssignedTopUp> {
    return this.pending.assign(actorOf(user), walletId, body);
  }
}

function actorOf(user: JwtPayload) {
  return { userId: user.sub, role: user.role, tenantId: user.tenantId };
}
