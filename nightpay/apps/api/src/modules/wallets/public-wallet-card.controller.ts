import { Body, Controller, Get, Header, Headers, HttpCode, Inject, NotFoundException, Param, Post, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply } from 'fastify';
import { isWalletCardToken } from '@nightpay/contracts';
import { Public } from '../../common/decorators/public.decorator';
import { IpRateLimit, type IpRateLimitConfig } from '../../common/guards/ip-rate-limit.guard';
import { customerLanguage } from '../payments/customer-lang';
import { WalletCardViewService, type CardPinView } from './wallet-card-view.service';
import { renderWalletUnlockPage } from './wallet-unlock-page';
import { walletViewSetCookies } from './wallet-view-session';

/**
 * «Ver mi saldo con mi PIN»: 30 intentos cada 15 min por IP y 8 por ficha e IP
 * (además de su propio contador de fallos por saldo: 5 y la vista se cierra 24 h).
 */
export const CARD_PIN_VIEW_LIMIT: IpRateLimitConfig = Object.freeze({
  max: 30,
  windowSec: 15 * 60,
  scope: 'wallet-card-pin',
  perKey: { param: 'token', max: 8 },
});

@Controller('w')
export class PublicWalletCardController {
  constructor(
    @Inject(WalletCardViewService) private readonly cards: WalletCardViewService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  @Public()
  @Get('card/:token')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @IpRateLimit({ max: 120, windowSec: 60, scope: 'wallet-card-view-page', failOpen: true })
  async page(@Param('token') token: string, @Query('lang') langQuery: string | undefined, @Headers('cookie') cookies: string | undefined, @Res() res: FastifyReply): Promise<void> {
    if (!isWalletCardToken(token)) throw new NotFoundException();
    // Antes de autenticarse, como mucho el código tapado (K7Q-•••): ni saldo, ni movimientos, ni el enlace.
    // Sin passkey, la pantalla dice cómo activarla (sin un botón que luego falle).
    const view = await this.cards.pageView(token);
    const { lang, setCookie } = customerLanguage(langQuery, cookies);
    if (setCookie) res.header('Set-Cookie', setCookie);
    res.type('text/html; charset=utf-8').send(renderWalletUnlockPage(`/w/card/${encodeURIComponent(token)}`, lang, view));
  }

  /** B7: «Recargar esta ficha» (solo suma): a la página de pago de siempre. */
  @Public()
  @Post('card/:token/topup')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 10, windowSec: 60, scope: 'wallet-card-topup' })
  async topUp(
    @Param('token') token: string,
    @Body() body: { amountCents?: unknown; key?: unknown; lang?: unknown } | undefined,
    @Headers('cookie') cookies: string | undefined,
  ): Promise<{ payUrl: string }> {
    if (!isWalletCardToken(token)) throw new NotFoundException();
    const { lang } = customerLanguage(typeof body?.lang === 'string' ? body.lang : undefined, cookies);
    return this.cards.startTopUp(token, { amountCents: body?.amountCents, key: body?.key, lang });
  }

  /**
   * B7: «Ver mi saldo con mi PIN» (10 min, sin pagos). Sus fallos van aparte
   * del PIN de pagar (5 → esta vista cerrada 24 h) y tiene su freno por IP
   * y por ficha e IP.
   */
  @Public()
  @Post('card/:token/pin')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit(CARD_PIN_VIEW_LIMIT)
  pinView(@Param('token') token: string, @Body() body: { pin?: unknown } | undefined): Promise<CardPinView> {
    if (!isWalletCardToken(token)) throw new NotFoundException();
    return this.cards.viewWithPin(token, body?.pin);
  }

  /** B7: «Actualizar» el saldo visto con el PIN, dentro de sus 10 min. */
  @Public()
  @Post('card/:token/saldo')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'wallet-card-pin-view' })
  pinViewAgain(@Param('token') token: string, @Body() body: { viewToken?: unknown } | undefined): Promise<CardPinView> {
    if (!isWalletCardToken(token)) throw new NotFoundException();
    return this.cards.viewAgain(token, body?.viewToken);
  }

  @Public()
  @Post('card/:token/view/challenge')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 120, windowSec: 60, scope: 'wallet-card-view' })
  challenge(@Param('token') token: string, @Headers('host') host: string | undefined): Promise<unknown> {
    return this.cards.challenge(token, host);
  }

  @Public()
  @Post('card/:token/view')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @IpRateLimit({ max: 120, windowSec: 60, scope: 'wallet-card-view' })
  async unlock(@Param('token') token: string, @Headers('host') host: string | undefined, @Body() body: { response?: unknown } | undefined, @Res({ passthrough: true }) res: FastifyReply): Promise<{ url: string }> {
    const wallet = await this.cards.unlock(token, host, body?.response);
    res.header('Set-Cookie', walletViewSetCookies(this.config.get<string>('COOKIE_SECRET') ?? '', wallet));
    return { url: `/w/${encodeURIComponent(wallet.qrToken)}` };
  }
}
