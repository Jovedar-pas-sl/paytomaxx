import { Body, Controller, Get, Header, Headers, HttpCode, Inject, NotFoundException, Param, Post, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply } from 'fastify';
import { isWalletCardToken } from '@nightpay/contracts';
import { Public } from '../../common/decorators/public.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { customerLanguage } from '../payments/customer-lang';
import { WalletCardViewService } from './wallet-card-view.service';
import { renderWalletUnlockPage } from './wallet-unlock-page';
import { walletViewSetCookies } from './wallet-view-session';

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
