import { Body, Controller, Get, Header, Headers, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public } from '../../common/decorators/public.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { customerLanguage, resolveLanguage } from '../payments/customer-lang';
import { HOME_TOPUP_PAGE_LIMIT, HOME_TOPUP_START_LIMIT } from './home-topup-rules';
import { renderHomeTopUpGone, renderHomeTopUpPage } from './home-topup-page';
import { HomeTopUpService } from './home-topup.service';

/**
 * «Cargar saldo antes de llegar»: el enlace público del local (fuera de /v1).
 *  - GET  /r/:code           → la página (4 idiomas). Apagado, sin código o con
 *                              un código cambiado: 404, la misma página sin pistas.
 *  - POST /r/:code/topup     → crea la carga (un saldo nuevo) y dice a dónde ir a
 *                              pagarla (/pay/:token). Freno por IP (y por IP y
 *                              local) aquí y por local en HomeTopUpService.
 *  - GET  /r/:code/mi-saldo  → «Recargar mi saldo»: a la página del saldo que
 *                              recuerda este navegador, en «Recargar» (303).
 * El enlace es público a propósito (decisión del dueño): cualquiera con él
 * carga. La página no enseña nada de nadie: el saldo que recuerda el
 * navegador, solo con su código tapado (K7Q-•••).
 */
@Controller('r')
export class PublicHomeTopUpController {
  constructor(@Inject(HomeTopUpService) private readonly homeTopUps: HomeTopUpService) {}

  @Public()
  @Get(':code')
  @IpRateLimit(HOME_TOPUP_PAGE_LIMIT)
  async page(
    @Param('code') code: string,
    @Query('lang') langQuery: string | undefined,
    @Headers('cookie') cookies: string | undefined,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const { lang, setCookie } = customerLanguage(langQuery, cookies);
    if (setCookie) res.header('Set-Cookie', setCookie);
    const view = await this.homeTopUps.page(code, cookies);
    if (!view) {
      sendHtml(res, 404, renderHomeTopUpGone(lang));
      return;
    }
    sendHtml(res, 200, renderHomeTopUpPage(code, lang, view));
  }

  @Public()
  @Get(':code/mi-saldo')
  @IpRateLimit(HOME_TOPUP_PAGE_LIMIT)
  async mySaldo(
    @Param('code') code: string,
    @Query('lang') langQuery: string | undefined,
    @Headers('cookie') cookies: string | undefined,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const lang = resolveLanguage(langQuery, cookies);
    const href = await this.homeTopUps.mySaldoHref(code, cookies, lang);
    // Sin saldo que recuerde (o el enlace ya no vale): de vuelta a la página del enlace.
    const location = href ?? `/r/${encodeURIComponent(code)}?lang=${lang}`;
    res.status(303).header('Location', location).header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').send();
  }

  @Public()
  @Post(':code/topup')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit(HOME_TOPUP_START_LIMIT)
  async start(
    @Param('code') code: string,
    @Body() body: { amountCents?: unknown; key?: unknown; lang?: unknown } | undefined,
    @Headers('cookie') cookies: string | undefined,
  ): Promise<{ payUrl: string }> {
    const lang = resolveLanguage(typeof body?.lang === 'string' ? body.lang : undefined, cookies);
    const started = await this.homeTopUps.start(code, { amountCents: body?.amountCents, key: body?.key, lang });
    return { payUrl: started.payUrl };
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
