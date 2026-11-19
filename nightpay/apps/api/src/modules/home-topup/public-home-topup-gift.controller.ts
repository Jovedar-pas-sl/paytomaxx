import { Body, Controller, Get, Header, Headers, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../../common/decorators/public.decorator';
import { IpRateLimit, clientIp } from '../../common/guards/ip-rate-limit.guard';
import { customerLanguage, resolveLanguage } from '../payments/customer-lang';
import { GIFT_PATH_PREFIX, HOME_TOPUP_PAGE_LIMIT, HOME_TOPUP_START_LIMIT } from './home-topup-rules';
import { GIFT_CLAIM_LIMIT } from './home-topup-gift';
import { renderGiftPage } from './home-topup-gift-page';
import { renderHomeTopUpGone } from './home-topup-page';
import { HomeTopUpGiftService } from './home-topup-gift.service';
import { HomeTopUpService } from './home-topup.service';

/**
 * «Regala una noche» (fuera de /v1, junto al enlace del local):
 *  - POST /r/:code/regalo             → el regalo: como «Cargar» (los mismos
 *                                       importes, topes y freno), con el nombre
 *                                       y el mensaje; dice a dónde ir a pagar.
 *                                       Con «Regalos» apagado, 404 sin pistas.
 *  - GET  /r/regalo/:token            → la página del regalo (?comprado=1:
 *                                       «Comparte tu regalo», sin «Guardar»).
 *  - POST /r/regalo/:token/guardar    → «Guardar en mi móvil»: 303 al QR de
 *                                       activación de siempre (/w/a/…); ya
 *                                       guardado o caducado, de vuelta a la página.
 * Lo que no existe (o sin pagar) da 404 con la página de «Este enlace no vale».
 */
@Controller('r')
export class PublicHomeTopUpGiftController {
  constructor(
    @Inject(HomeTopUpService) private readonly homeTopUps: HomeTopUpService,
    @Inject(HomeTopUpGiftService) private readonly gifts: HomeTopUpGiftService,
  ) {}

  @Public()
  @Post(':code/regalo')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit(HOME_TOPUP_START_LIMIT)
  async start(
    @Param('code') code: string,
    @Body() body: { amountCents?: unknown; key?: unknown; lang?: unknown; name?: unknown; message?: unknown } | undefined,
    @Headers('cookie') cookies: string | undefined,
    @Req() req: FastifyRequest,
  ): Promise<{ payUrl: string }> {
    const lang = resolveLanguage(typeof body?.lang === 'string' ? body.lang : undefined, cookies);
    const started = await this.homeTopUps.start(code, {
      amountCents: body?.amountCents,
      key: body?.key,
      lang,
      ip: clientIp(req),
      gift: { name: body?.name, message: body?.message },
    });
    return { payUrl: started.payUrl };
  }

  @Public()
  @Get('regalo/:token')
  @IpRateLimit(HOME_TOPUP_PAGE_LIMIT)
  async page(
    @Param('token') token: string,
    @Query('lang') langQuery: string | undefined,
    @Query('comprado') bought: string | undefined,
    @Headers('cookie') cookies: string | undefined,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const { lang, setCookie } = customerLanguage(langQuery, cookies);
    if (setCookie) res.header('Set-Cookie', setCookie);
    const view = await this.gifts.view(token);
    if (!view) {
      sendHtml(res, 404, renderHomeTopUpGone(lang));
      return;
    }
    sendHtml(res, 200, renderGiftPage(token, lang, view, { share: bought === '1', origin: this.gifts.origin }));
  }

  @Public()
  @Post('regalo/:token/guardar')
  @IpRateLimit(GIFT_CLAIM_LIMIT)
  async claim(
    @Param('token') token: string,
    @Query('lang') langQuery: string | undefined,
    @Headers('cookie') cookies: string | undefined,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const lang = resolveLanguage(langQuery, cookies);
    const claim = await this.gifts.claim(token);
    if (!claim) {
      sendHtml(res, 404, renderHomeTopUpGone(lang));
      return;
    }
    const location =
      'activationPath' in claim ? `${claim.activationPath}?lang=${lang}` : `${GIFT_PATH_PREFIX}${encodeURIComponent(token)}?lang=${lang}`;
    res.status(303).header('Location', location).header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').send();
  }
}

function sendHtml(res: FastifyReply, status: number, html: string): void {
  res
    .status(status)
    .header('Content-Type', 'text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .header('Referrer-Policy', 'no-referrer')
    .send(html);
}
