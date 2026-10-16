import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public } from '../../common/decorators/public.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { resolveLanguage } from '../payments/pay-i18n';
import { WalletChargesService, type ClientWalletState } from './wallet-charges.service';
import { WalletPasskeysService } from './wallet-passkeys.service';
import { renderWalletPage } from './wallet-page';
import { GoogleWalletService } from './google-wallet/google-wallet.service';

/**
 * Saldo NightPay — páginas del cliente (fuera de /v1). Sin cuenta: el enlace
 * con su token es la credencial (como el QR del cobro).
 *  - GET  /w/:token                          → página del saldo.
 *  - GET  /w/:token/state                    → estado (la página lo refresca).
 *  - POST /w/:token/passkey/options, /passkey → activar Face ID.
 *  - POST /w/:token/pin                      → elegir PIN (si aún no tiene).
 *  - POST /w/:token/merge/challenge, /merge  → sumar este saldo al de su Face ID.
 *  - POST /w/:token/close                    → "Me voy: devolver mi saldo".
 *  - POST /w/:token/google-wallet            → guardar el saldo en Google Wallet
 *    (GoogleWalletController; el botón sale solo en Android y si está configurado).
 * Aquí no se paga: se paga escaneando el QR de la chica (/s/:token, con Face
 * ID) o con el código o la ficha y el PIN en el móvil de la chica.
 *
 * Límites por IP holgados: en un local muchos clientes comparten el wifi y la
 * página consulta su estado cada pocos segundos. El token (144 bits) no se
 * puede adivinar; el límite es contra abusos, no contra fuerza bruta.
 */
@Controller('w')
export class PublicWalletController {
  private readonly charges: WalletChargesService;
  private readonly passkeys: WalletPasskeysService;
  private readonly gwallet: GoogleWalletService;

  constructor(
    @Inject(WalletChargesService) charges: WalletChargesService,
    @Inject(WalletPasskeysService) passkeys: WalletPasskeysService,
    @Inject(GoogleWalletService) gwallet: GoogleWalletService,
  ) {
    this.charges = charges;
    this.passkeys = passkeys;
    this.gwallet = gwallet;
  }

  /** Activar Face ID, paso 1 (con el enlace del saldo; solo si aún no tiene). */
  @Public()
  @Post(':token/passkey/options')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'wallet-passkey' })
  async passkeyOptions(@Param('token') token: string, @Headers('host') host: string | undefined): Promise<unknown> {
    return this.passkeys.registrationOptions(await this.charges.walletRefByToken(token), host);
  }

  /** Activar Face ID, paso 2: la respuesta de su móvil. */
  @Public()
  @Post(':token/passkey')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'wallet-passkey' })
  async passkeyRegister(
    @Param('token') token: string,
    @Body() body: { response?: unknown } | undefined,
    @Headers('host') host: string | undefined,
  ): Promise<ClientWalletState> {
    const wallet = await this.charges.walletRefByToken(token);
    await this.passkeys.register(wallet.id, host, body?.response);
    return this.charges.clientState(token);
  }

  /**
   * Elegir PIN (para pagar sin sacar el móvil), desde la página del saldo.
   * Lo mismo que en el «Pagado» de la recarga: solo si aún no tiene PIN.
   */
  @Public()
  @Post(':token/pin')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'wallet-pin' })
  async pin(
    @Param('token') token: string,
    @Body() body: { pin?: unknown; pin2?: unknown } | undefined,
  ): Promise<ClientWalletState> {
    const pin = typeof body?.pin === 'string' ? body.pin : '';
    if (!/^[0-9]{4}$/.test(pin)) throw new BadRequestException('El PIN son 4 cifras');
    if (body?.pin2 !== pin) throw new BadRequestException('Los dos PIN no son iguales');
    const wallet = await this.charges.walletRefByToken(token);
    await this.charges.setPinFromPayer(wallet.id, pin);
    return this.charges.clientState(token);
  }

  /** Sumar este saldo al de siempre, paso 1: reto para su llave (Face ID…). */
  @Public()
  @Post(':token/merge/challenge')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'wallet-merge' })
  async mergeChallenge(@Param('token') token: string, @Headers('host') host: string | undefined): Promise<unknown> {
    const wallet = await this.charges.walletRefByToken(token);
    return this.passkeys.challenge(`merge:${wallet.id}`, host);
  }

  /** Paso 2: su llave dice cuál es su saldo de siempre; este se suma a aquel. */
  @Public()
  @Post(':token/merge')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'wallet-merge' })
  async merge(
    @Param('token') token: string,
    @Body() body: { response?: unknown } | undefined,
    @Headers('host') host: string | undefined,
  ): Promise<{ balanceCents: number }> {
    const wallet = await this.charges.walletRefByToken(token);
    const target = await this.passkeys.verify(`merge:${wallet.id}`, host, body?.response);
    return this.charges.mergeInto(wallet.id, target);
  }

  @Public()
  @Get(':token')
  @IpRateLimit({ max: 120, windowSec: 60, scope: 'wallet-page' })
  async page(
    @Param('token') token: string,
    @Query('lang') langQuery: string | undefined,
    @Headers('accept-language') acceptLanguage: string | undefined,
    @Res() res: FastifyReply,
  ): Promise<void> {
    // Ya no hay QR del código: para pagar, el cliente escanea el QR de la
    // chica y desbloquea su móvil (Face ID).
    const state = await this.charges.clientState(token);
    res
      .status(200)
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(
        renderWalletPage(token, resolveLanguage(langQuery, acceptLanguage), state, {
          googleWallet: this.gwallet.enabled,
        }),
      );
  }

  @Public()
  @Get(':token/state')
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 1500, windowSec: 60, scope: 'wallet-state' })
  async state(@Param('token') token: string): Promise<ClientWalletState> {
    return this.charges.clientState(token);
  }

  @Public()
  @Post(':token/close')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'wallet-close' })
  async close(@Param('token') token: string): Promise<ClientWalletState> {
    return this.charges.requestClose(token);
  }
}
