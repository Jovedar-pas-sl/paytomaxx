import { Body, Controller, Get, Header, Headers, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply } from 'fastify';
import { Public } from '../../common/decorators/public.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { customerLanguage } from '../payments/customer-lang';
import { checkedPin } from './client-pin';
import { renderActivationPage } from './wallet-activation-page';
import { WalletActivationUseService } from './wallet-activation-use.service';
import { walletViewSetCookies } from './wallet-view-session';

/**
 * El QR de activación de un solo uso (M-2), en el móvil del cliente (fuera de /v1):
 *  - GET  /w/a/:token                   → la página (no gasta nada: las vistas
 *                                          previas de WhatsApp también la abren).
 *  - POST /w/a/:token/passkey/options   → activar Face ID, paso 1 (con su PIN si
 *                                          el QR es de recepción y el saldo ya lo tenía).
 *  - POST /w/a/:token/passkey           → paso 2: gasta el QR y deja la sesión
 *                                          del saldo; devuelve a dónde ir (/w/<enlace>).
 *  - POST /w/a/:token/pin               → el primer PIN: gasta el QR y cambia el enlace.
 * 409 ACTIVATION_USED si ya se usó; 410 ACTIVATION_EXPIRED si caducó, se
 * anuló o no existe. El enlace del saldo solo lo recibe el móvil que activa.
 */
@Controller('w')
export class PublicWalletActivationController {
  constructor(
    @Inject(WalletActivationUseService) private readonly uses: WalletActivationUseService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  @Public()
  @Get('a/:token')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'wallet-activation-page', failOpen: true })
  async page(
    @Param('token') token: string,
    @Query('lang') langQuery: string | undefined,
    @Headers('cookie') cookies: string | undefined,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const { lang, setCookie } = customerLanguage(langQuery, cookies);
    if (setCookie) res.header('Set-Cookie', setCookie);
    const view = await this.uses.view(token);
    res
      .status(view.state === 'ok' ? 200 : 410)
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Robots-Tag', 'noindex, nofollow')
      .send(renderActivationPage(`/w/a/${encodeURIComponent(token)}`, lang, view));
  }

  @Public()
  @Post('a/:token/passkey/options')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'wallet-activation' })
  async passkeyOptions(
    @Param('token') token: string,
    @Body() body: { pin?: unknown } | undefined,
    @Headers('host') host: string | undefined,
  ): Promise<unknown> {
    return this.uses.passkeyOptions(token, host, body?.pin);
  }

  @Public()
  @Post('a/:token/passkey')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'wallet-activation' })
  async passkey(
    @Param('token') token: string,
    @Body() body: { response?: unknown; pin?: unknown } | undefined,
    @Headers('host') host: string | undefined,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<{ url: string; hadPin: boolean }> {
    const out = await this.uses.registerPasskey(token, host, body?.response, body?.pin);
    // Su móvil sigue a su saldo ya desbloqueado (la sesión de consulta, como tras Face ID).
    res.header('Set-Cookie', walletViewSetCookies(this.config.get<string>('COOKIE_SECRET') ?? '', { id: out.walletId, qrToken: out.qrToken }));
    return { url: `/w/${encodeURIComponent(out.qrToken)}`, hadPin: out.hadPin };
  }

  @Public()
  @Post('a/:token/pin')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'wallet-activation' })
  async pin(
    @Param('token') token: string,
    @Body() body: { pin?: unknown; pin2?: unknown } | undefined,
  ): Promise<{ url: string }> {
    const pin = checkedPin(body);
    const out = await this.uses.setPin(token, pin);
    return { url: `/w/${encodeURIComponent(out.qrToken)}` };
  }
}
