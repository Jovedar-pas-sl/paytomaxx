import { Body, Controller, Header, Headers, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { WalletChargesService, type ClientWalletState } from './wallet-charges.service';
import { WalletLostCardService } from './wallet-lost-card.service';

/**
 * «He perdido mi NFC», desde la página del saldo (/w/:token), con su Face ID:
 *  - POST /w/:token/lost-nfc/challenge → reto para su passkey (409 FACE_ID_NOT_SET si no tiene).
 *  - POST /w/:token/lost-nfc           → bloquea su NFC y devuelve el estado del saldo.
 */
@Controller('w')
export class PublicWalletLostCardController {
  constructor(
    @Inject(WalletChargesService) private readonly charges: WalletChargesService,
    @Inject(WalletLostCardService) private readonly lost: WalletLostCardService,
  ) {}

  @Public()
  @Post(':token/lost-nfc/challenge')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'wallet-lost-nfc' })
  async challenge(@Param('token') token: string, @Headers('host') host: string | undefined): Promise<unknown> {
    const wallet = await this.charges.walletRefByToken(token);
    return this.lost.challenge(wallet.id, host);
  }

  @Public()
  @Post(':token/lost-nfc')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'wallet-lost-nfc' })
  async block(
    @Param('token') token: string,
    @Body() body: { response?: unknown } | undefined,
    @Headers('host') host: string | undefined,
  ): Promise<ClientWalletState> {
    const wallet = await this.charges.walletRefByToken(token);
    await this.lost.block(wallet.id, host, body?.response);
    return this.charges.clientState(token);
  }
}
