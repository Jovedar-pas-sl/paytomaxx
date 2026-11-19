import { createHash, randomBytes } from 'node:crypto';
import { Controller, Get, Headers, HttpCode, Inject, Logger, Param, Post, Query, Req, Res, UseFilters, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { BtcpayInvoiceView } from '@nightpay/contracts';
import { Public } from '../../common/decorators/public.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { customerLanguage } from '../payments/customer-lang';
import { payErrorKeyOf, type PayLanguage } from '../payments/pay-i18n';
import { PayPageFilter } from '../payments/pay-page.filter';
import { renderErrorPage } from '../payments/public-pay.pages';
import { walletClaimCookieName, walletClaimSetCookie } from '../payments/wallet-claim';
import { isReservationPaymentKey } from '../reservations/reservation-payment-key';
import { BtcpayInvoiceService } from './btcpay-invoice.service';
import { BtcpayEnabledGuard } from './btcpay-flag';
import { renderBitcoinPage } from './btcpay-pay-page';

const PAGE_LIMIT = { max: 600, windowSec: 60, scope: 'pay-page', failOpen: true } as const;
const STATUS_LIMIT = { max: 3_000, windowSec: 60, scope: 'pay-status', failOpen: true, perKey: { param: 'token', max: 120 } } as const;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sendHtml(res: FastifyReply, status: number, html: string): void {
  res.status(status).header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'no-store').send(html);
}

/** Una factura vacía para la página de «hay un problema» (no pinta el QR). */
const NO_INVOICE: BtcpayInvoiceView = {
  invoiceId: '',
  status: 'Expired',
  amountCents: 0,
  amountBtc: null,
  rate: null,
  qrLink: '',
  chainAddress: null,
  checkoutLink: '',
  expiresAt: new Date(0).toISOString(),
  paymentStatus: '',
  qrImage: '',
};

/**
 * Páginas públicas de «Pagar con bitcoin» (fuera de /v1, como /pay):
 *  - POST /pay/:token/bitcoin         el cliente tocó «Pagar con bitcoin»: abre (o reutiliza) la factura y va a la página
 *  - GET  /pay/:token/bitcoin         el QR, el importe en euros y en BTC y el tiempo que queda
 *  - GET  /pay/:token/bitcoin/status  su estado en JSON (pregunta a BTCPay como mucho cada 5 s por factura)
 * El importe sale siempre del servidor; del navegador no se lee nada salvo el idioma.
 */
@Controller('pay')
@UseGuards(BtcpayEnabledGuard)
export class BtcpayPayController {
  private readonly logger = new Logger(BtcpayPayController.name);

  constructor(
    @Inject(BtcpayInvoiceService) private readonly invoices: BtcpayInvoiceService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  @Public()
  @Post(':token/bitcoin')
  @HttpCode(200)
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'pay-bitcoin' })
  async start(
    @Param('token') token: string,
    @Query('lang') langQuery: string | undefined,
    @Headers('cookie') cookies: string | undefined,
    @Res() res: FastifyReply,
    @Req() req?: FastifyRequest,
  ): Promise<void> {
    const lang = this.language(res, langQuery, cookies);
    const claim = this.cookieValue(req, token) ?? randomBytes(32).toString('base64url');
    try {
      const result = await this.invoices.startForToken(token, sha256(claim));
      // Como el pago con tarjeta: la cookie de este navegador (vuelve a su saldo si era una recarga).
      res.header('Set-Cookie', walletClaimSetCookie(this.cookieSecret(), token, claim));
      const next = result.kind === 'invoice' ? `/pay/${encodeURIComponent(token)}/bitcoin?lang=${lang}` : `/pay/${encodeURIComponent(token)}?lang=${lang}`;
      res.status(303).header('Location', next).header('Cache-Control', 'no-store').send();
    } catch (err) {
      this.logger.warn(`/pay/${token.slice(0, 4)}…/bitcoin: ${(err as Error).message}`);
      sendHtml(res, 409, renderErrorPage(payErrorKeyOf(err), lang, `/pay/${encodeURIComponent(token)}?lang=${lang}`));
    }
  }

  /**
   * «Pagar de otra forma»: cierra la factura abierta y vuelve a /pay/:token con
   * las demás formas de pago. Con el pago ya en la red no se cierra: vuelve al QR,
   * que dice que se está confirmando. Ya pagado: /pay/:token enseña el «Pagado».
   */
  @Public()
  @Post(':token/bitcoin/other')
  @HttpCode(200)
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'pay-bitcoin' })
  async other(
    @Param('token') token: string,
    @Query('lang') langQuery: string | undefined,
    @Headers('cookie') cookies: string | undefined,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const lang = this.language(res, langQuery, cookies);
    const back = `/pay/${encodeURIComponent(token)}?lang=${lang}`;
    try {
      const result = await this.invoices.leaveForToken(token);
      const next = result.kind === 'confirming' ? `/pay/${encodeURIComponent(token)}/bitcoin?lang=${lang}` : back;
      res.status(303).header('Location', next).header('Cache-Control', 'no-store').send();
    } catch (err) {
      this.logger.warn(`/pay/${token.slice(0, 4)}…/bitcoin/other: ${(err as Error).message}`);
      sendHtml(res, 409, renderErrorPage(payErrorKeyOf(err), lang, back));
    }
  }

  @Public()
  @Get(':token/bitcoin')
  @IpRateLimit(PAGE_LIMIT)
  @UseFilters(new PayPageFilter())
  async page(
    @Param('token') token: string,
    @Query('lang') langQuery: string | undefined,
    @Headers('cookie') cookies: string | undefined,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const lang = this.language(res, langQuery, cookies);
    const back = `/pay/${encodeURIComponent(token)}?lang=${lang}`;
    const { payment, view } = await this.invoices.viewForToken(token);
    if (view) {
      // Una carga de saldo (no un reservado): la regla del saldo antes del QR.
      const topUp = payment.walletId !== null && !isReservationPaymentKey(payment.idempotencyKey);
      sendHtml(res, 200, this.render(lang, token, view, null, topUp));
      return;
    }
    // Sin factura abierta: pagado, cerrado o elegir lo cuenta la página del cobro. Con un pago a medias, el aviso.
    const poll = await this.invoices.pollForToken(token);
    if (poll.state === 'incident') {
      sendHtml(res, 200, this.render(lang, token, NO_INVOICE, 'problem'));
      return;
    }
    res.status(303).header('Location', back).header('Cache-Control', 'no-store').send();
  }

  @Public()
  @Get(':token/bitcoin/status')
  @IpRateLimit(STATUS_LIMIT)
  async status(@Param('token') token: string, @Res() res: FastifyReply): Promise<void> {
    const state = await this.invoices.pollForToken(token);
    res.status(200).header('Content-Type', 'application/json; charset=utf-8').header('Cache-Control', 'no-store').send(JSON.stringify(state));
  }

  // ─── Detalles ───────────────────────────────────────────────────────

  private render(lang: PayLanguage, token: string, view: BtcpayInvoiceView, closed: 'problem' | null, topUp = false): string {
    return renderBitcoinPage({
      token,
      lang,
      view,
      venueName: null,
      concept: null,
      langHref: (l) => `/pay/${encodeURIComponent(token)}/bitcoin?lang=${l}`,
      closed,
      topUp,
    });
  }

  private language(res: FastifyReply, query: unknown, cookies: string | undefined): PayLanguage {
    const { lang, setCookie } = customerLanguage(query, cookies);
    if (setCookie) res.header('Set-Cookie', setCookie);
    return lang;
  }

  private cookieSecret(): string {
    return this.config.get<string>('COOKIE_SECRET') ?? '';
  }

  private cookieValue(req: FastifyRequest | undefined, token: string): string | null {
    const prefix = `${walletClaimCookieName(this.cookieSecret(), token)}=`;
    for (const part of (req?.headers.cookie ?? '').split(';')) {
      const c = part.trim();
      if (!c.startsWith(prefix)) continue;
      const value = c.slice(prefix.length);
      if (/^[A-Za-z0-9_-]{43}$/.test(value)) return value;
    }
    return null;
  }
}
