import { Body, Controller, Get, Header, Headers, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../../common/decorators/public.decorator';
import { IpRateLimit, clientIp } from '../../common/guards/ip-rate-limit.guard';
import { customerLanguage, resolveLanguage } from '../payments/customer-lang';
import { HOME_TOPUP_PAGE_LIMIT, HOME_TOPUP_START_LIMIT } from './home-topup-rules';
import { QUEUE_PARAM, QUEUE_START_LIMIT } from './home-topup-queue';
import { renderHomeTopUpGone, renderHomeTopUpPage } from './home-topup-page';
import { HomeTopUpService } from './home-topup.service';

/**
 * «Cargar saldo antes de llegar»: el enlace público del local (fuera de /v1).
 *  - GET  /r/:code           → la página (4 idiomas). Apagado, sin código o con
 *                              un código cambiado: 404, la misma página sin pistas.
 *  - POST /r/:code/topup     → crea la carga (un saldo nuevo) y dice a dónde ir a
 *                              pagarla (/pay/:token). Freno por IP (y por IP y
 *                              local) aquí; por local y el tope de 24 h por IP,
 *                              en HomeTopUpService.
 *  - POST /r/:code/cola      → lo mismo desde el QR del cartel de la cola (B16):
 *                              sin el tope por IP (la cola sale por el wifi del
 *                              local); con el QR de esta noche y los topes por
 *                              móvil (cookie firmada, la pone GET ?cola=) y por noche.
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
    /** El QR del cartel de la cola (B16). */
    @Query(QUEUE_PARAM) queueToken?: string,
  ): Promise<void> {
    const { lang, setCookie } = customerLanguage(langQuery, cookies);
    const view = await this.homeTopUps.page(code, cookies, typeof queueToken === 'string' ? queueToken : undefined);
    // Con el QR del cartel de esta noche: la cookie del móvil (su tope por noche).
    const device = view?.queue && 'token' in view.queue ? this.homeTopUps.queueDeviceSetCookie(cookies) : null;
    for (const cookie of [setCookie, device]) if (cookie) res.header('Set-Cookie', cookie);
    if (!view) {
      sendHtml(res, 404, renderHomeTopUpGone(lang));
      return;
    }
    sendHtml(res, 200, renderHomeTopUpPage(code, lang, view));
  }

  @Public()
  @Post(':code/cola')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit(QUEUE_START_LIMIT)
  async startFromQueue(
    @Param('code') code: string,
    @Body() body: { amountCents?: unknown; key?: unknown; lang?: unknown; queue?: unknown } | undefined,
    @Headers('cookie') cookies: string | undefined,
    @Req() req: FastifyRequest,
  ): Promise<{ payUrl: string }> {
    const lang = resolveLanguage(typeof body?.lang === 'string' ? body.lang : undefined, cookies);
    const started = await this.homeTopUps.start(code, {
      amountCents: body?.amountCents,
      key: body?.key,
      lang,
      ip: clientIp(req),
      queue: { token: body?.queue, deviceId: this.homeTopUps.queueDevice(cookies) },
    });
    return { payUrl: started.payUrl };
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
    @Req() req: FastifyRequest,
  ): Promise<{ payUrl: string }> {
    const lang = resolveLanguage(typeof body?.lang === 'string' ? body.lang : undefined, cookies);
    // La IP de fiar (la misma del freno de las IP), para el tope de 24 h.
    const ip = clientIp(req);
    const started = await this.homeTopUps.start(code, { amountCents: body?.amountCents, key: body?.key, lang, ip });
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
