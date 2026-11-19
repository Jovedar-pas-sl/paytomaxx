import { Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { saldoNoSeDevuelve } from './saldo-rule';

/**
 * La salida de recepción ya no devuelve el saldo (decisión del dueño,
 * 17-nov-2026: saldo-rule.ts). Las rutas siguen, con las mismas personas y
 * topes, para que una app del personal de antes reciba el 409
 * SALDO_NO_SE_DEVUELVE con su mensaje (y no un 404):
 *  - POST /v1/reception/wallets/:id/payout/plan
 *  - POST /v1/reception/wallets/:id/payout/passkey
 *  - GET  /v1/reception/wallets/:id/payout/passkey/:key
 *  - POST /v1/reception/wallets/:id/payout
 * Lo que recepción dejó antes para el encargado o «A la tarjeta» se termina
 * en el panel (WalletChargesService.payout).
 */
@Controller('reception')
@UseGuards(RolesGuard)
export class ReceptionCashPayoutController {
  @Post('wallets/:id/payout')
  @HttpCode(200)
  @Roles('WAITER', 'MANAGER', 'OWNER')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'reception-payout' })
  payout(): never {
    throw saldoNoSeDevuelve();
  }

  @Post('wallets/:id/payout/plan')
  @HttpCode(200)
  @Roles('WAITER', 'MANAGER', 'OWNER')
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'reception-payout-plan' })
  plan(): never {
    throw saldoNoSeDevuelve();
  }

  @Post('wallets/:id/payout/passkey')
  @HttpCode(200)
  @Roles('WAITER', 'MANAGER', 'OWNER')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'reception-payout-passkey' })
  passkey(): never {
    throw saldoNoSeDevuelve();
  }

  @Get('wallets/:id/payout/passkey/:requestKey')
  @Roles('WAITER', 'MANAGER', 'OWNER')
  @IpRateLimit({ max: 120, windowSec: 60, scope: 'reception-payout-passkey-status' })
  passkeyStatus(): never {
    throw saldoNoSeDevuelve();
  }
}
