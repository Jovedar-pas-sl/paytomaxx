import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
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

/**
 * Saldo NightPay — páginas del cliente (fuera de /v1). Sin cuenta: el enlace
 * con su token es la credencial (como el QR del cobro).
 *  - GET  /w/:token                          → página del saldo.
 *  - GET  /w/:token/state                    → estado (la página lo refresca).
 *  - POST /w/:token/requests/:id/accept|reject → aceptar o rechazar un cobro.
 *  - POST /w/:token/close                    → "Me voy: devolver mi saldo".
 *
 * Límites por IP holgados: en un local muchos clientes comparten el wifi y la
 * página consulta su estado cada pocos segundos. El token (144 bits) no se
 * puede adivinar; el límite es contra abusos, no contra fuerza bruta.
 */
@Controller('w')
export class PublicWalletController {
  private readonly charges: WalletChargesService;
  private readonly passkeys: WalletPasskeysService;

  constructor(
    @Inject(WalletChargesService) charges: WalletChargesService,
    @Inject(WalletPasskeysService) passkeys: WalletPasskeysService,
  ) {
    this.charges = charges;
    this.passkeys = passkeys;
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
      .send(renderWalletPage(token, resolveLanguage(langQuery, acceptLanguage), state));
  }

  @Public()
  @Get(':token/state')
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 1500, windowSec: 60, scope: 'wallet-state' })
  async state(@Param('token') token: string): Promise<ClientWalletState> {
    return this.charges.clientState(token);
  }

  @Public()
  @Post(':token/requests/:id/accept')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'wallet-decide' })
  async accept(@Param('token') token: string, @Param('id', ParseUUIDPipe) id: string): Promise<ClientWalletState> {
    return this.charges.accept(token, id);
  }

  @Public()
  @Post(':token/requests/:id/reject')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'wallet-decide' })
  async reject(@Param('token') token: string, @Param('id', ParseUUIDPipe) id: string): Promise<ClientWalletState> {
    return this.charges.reject(token, id);
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
