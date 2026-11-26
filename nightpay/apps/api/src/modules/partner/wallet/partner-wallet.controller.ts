import { Body, Controller, Inject } from '@nestjs/common';
import { PARTNER_ROUTES, WalletBalanceRequest, type WalletBalance } from '@nightpay/contracts';
import { ZodValidationPipe } from '../../../common/pipes/zod.pipe';
import { CurrentConnection, type PartnerAuth } from '../auth/current-connection.decorator';
import { PartnerRoute } from '../http/partner-route.decorator';
import { PartnerWalletLimits } from './partner-wallet-limits';
import { PartnerWalletRefs } from './partner-wallet-ref';

/**
 * `POST /v1/partner/wallet/balance`: identificar un saldo y leer su saldo.
 * No mueve dinero ni escribe en el saldo, y no mira la pausa ni los
 * interruptores del local (solo la carga). Los topes, lo último antes del 200.
 */
@Controller('partner')
export class PartnerWalletController {
  constructor(
    @Inject(PartnerWalletRefs) private readonly refs: PartnerWalletRefs,
    @Inject(PartnerWalletLimits) private readonly limits: PartnerWalletLimits,
  ) {}

  @PartnerRoute(PARTNER_ROUTES.getWalletBalance)
  async balance(
    @CurrentConnection() auth: PartnerAuth,
    @Body(new ZodValidationPipe(WalletBalanceRequest)) body: WalletBalanceRequest,
  ): Promise<WalletBalance> {
    const ref = await this.refs.resolve(auth, body);
    await this.limits.balance(auth, ref.walletId, ref.refKind);
    return { object: 'wallet_balance', available: ref.balanceCents, currency: 'EUR', livemode: auth.connection.keyMode === 'live' };
  }
}
