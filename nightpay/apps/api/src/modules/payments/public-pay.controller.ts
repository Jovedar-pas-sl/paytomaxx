import { Body, Controller, Get, Headers, HttpCode, Inject, Logger, Param, Post, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { Public } from '../../common/decorators/public.decorator';
import { PaymentsService } from './payments.service';
import { confirmationCode, type CheckoutChoice, type PayRedirect } from './pay-redirect';
import { detectPayDevice } from './pay-device';
import { payErrorKey, resolveLanguage, type PayLanguage } from './pay-i18n';
import {
  payHref,
  receiptHref,
  renderCheckoutForm,
  renderChoosePage,
  renderClosedPage,
  renderErrorPage,
  renderPaidPage,
  renderProcessingPage,
  renderReceiptPage,
  renderResultView,
} from './public-pay.pages';

/** Formulario de la página de pago. `method` vacío = sin preferencia. */
const CheckoutFormSchema = z.object({
  tip: z.coerce.number().int().min(0).max(100_000).default(0),
  method: z
    .enum(['wallet', 'card', ''])
    .optional()
    .transform((m) => (m === 'wallet' || m === 'card' ? m : null)),
  lang: z.enum(['es', 'en']).optional(),
});

/**
 * Páginas públicas del cliente (FUERA del prefijo /v1):
 *  - GET  /pay/:token          → al escanear el QR: página de pago (importe,
 *                                propina, Apple Pay / Google Pay o tarjeta), o
 *                                "Pagado" / "Comprobando" / cerrado.
 *  - POST /pay/:token          → el cliente pulsó un botón: abre el pedido en
 *                                el banco por importe + propina y redirige (303)
 *                                a /pay/:token/checkout.
 *  - GET  /pay/:token/checkout → formulario que se envía solo al banco. Si el
 *                                cliente vuelve atrás desde el banco no se
 *                                reenvía nada: vuelve a la página del cobro.
 *  - GET  /pay/result?op=…     → vuelta del banco (URLOK/URLKO): estado REAL
 *                                leído de la base de datos; el `status` de la
 *                                URL se ignora (cualquiera puede escribirlo).
 *  - GET  /pay/:token/receipt  → justificante, solo si está pagado.
 *
 * Español o inglés (?lang= o idioma del móvil). Textos discretos, sin
 * nombres internos.
 */
@Controller('pay')
export class PublicPayController {
  private readonly logger = new Logger(PublicPayController.name);
  private readonly payments: PaymentsService;
  private readonly config: ConfigService;

  constructor(@Inject(PaymentsService) payments: PaymentsService, @Inject(ConfigService) config: ConfigService) {
    this.payments = payments;
    this.config = config;
  }

  @Public()
  @Get('result')
  async paymentResult(
    @Query('op') op: string | undefined,
    @Query('lang') langQuery: string | undefined,
    @Headers('accept-language') acceptLanguage: string | undefined,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const lang = resolveLanguage(langQuery, acceptLanguage);
    const view = op ? await this.payments.getResultView(op) : null;
    const refreshUrl = `/pay/result?op=${encodeURIComponent(op ?? '')}&lang=${lang}`;
    sendHtml(res, 200, renderResultView(view, lang, refreshUrl));
  }

  @Public()
  @Get(':token/receipt')
  async receipt(
    @Param('token') token: string,
    @Query('lang') langQuery: string | undefined,
    @Headers('accept-language') acceptLanguage: string | undefined,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const lang = resolveLanguage(langQuery, acceptLanguage);
    const receipt = await this.payments.getReceipt(token);
    if (!receipt) {
      sendHtml(res, 404, renderErrorPage('notFound', lang));
      return;
    }
    sendHtml(
      res,
      200,
      renderReceiptPage(receipt, { lang, statementName: this.statementName(), backHref: payHref(token, lang) }),
    );
  }

  @Public()
  @Get(':token/checkout')
  async checkout(
    @Param('token') token: string,
    @Query('op') op: string | undefined,
    @Query('lang') langQuery: string | undefined,
    @Headers('accept-language') acceptLanguage: string | undefined,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const lang = resolveLanguage(langQuery, acceptLanguage);
    const form = op ? await this.payments.getCheckoutForm(token, op) : null;
    if (form?.kind !== 'form') {
      res.status(303).header('Location', payHref(token, lang)).header('Cache-Control', 'no-store').send();
      return;
    }
    sendHtml(res, 200, renderCheckoutForm(form.action, form.fields, lang, payHref(token, lang)));
  }

  @Public()
  @Get(':token')
  async payPage(
    @Param('token') token: string,
    @Query('lang') langQuery: string | undefined,
    @Headers('accept-language') acceptLanguage: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const lang = resolveLanguage(langQuery, acceptLanguage);
    try {
      const view = await this.payments.getPayPage(token);
      this.send(res, token, lang, view, userAgent);
    } catch (err) {
      this.sendError(res, token, lang, err);
    }
  }

  @Public()
  @Post(':token')
  @HttpCode(200)
  async startCheckout(
    @Param('token') token: string,
    @Body() body: unknown,
    @Headers('accept-language') acceptLanguage: string | undefined,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const parsed = CheckoutFormSchema.safeParse(body ?? {});
    const lang = resolveLanguage(parsed.success ? parsed.data.lang : undefined, acceptLanguage);
    if (!parsed.success) {
      sendHtml(res, 400, renderErrorPage('generic', lang));
      return;
    }
    const choice: CheckoutChoice = { tipCents: parsed.data.tip, method: parsed.data.method, language: lang };
    try {
      const view = await this.payments.startCheckout(token, choice);
      this.send(res, token, lang, view, undefined);
    } catch (err) {
      this.sendError(res, token, lang, err);
    }
  }

  private send(
    res: FastifyReply,
    token: string,
    lang: PayLanguage,
    view: PayRedirect,
    userAgent: string | undefined,
  ): void {
    switch (view.kind) {
      case 'choose':
        sendHtml(
          res,
          200,
          renderChoosePage(view, {
            token,
            lang,
            device: detectPayDevice(userAgent),
            statementName: this.statementName(),
            now: new Date(),
          }),
        );
        return;
      case 'redirect':
        // Paytef u otros PSPs con URL hosted → 302
        res.status(302).header('Location', view.url).send();
        return;
      case 'checkout':
        // Post/Redirect/Get: el historial guarda el GET, no el POST.
        res
          .status(303)
          .header('Location', `/pay/${encodeURIComponent(token)}/checkout?op=${encodeURIComponent(view.order)}&lang=${lang}`)
          .header('Cache-Control', 'no-store')
          .send();
        return;
      case 'form':
        sendHtml(res, 200, renderCheckoutForm(view.action, view.fields, lang, payHref(token, lang)));
        return;
      case 'paid':
        sendHtml(
          res,
          200,
          renderPaidPage(
            {
              amountCents: view.amountCents,
              tipCents: view.tipCents,
              currency: view.currency,
              code: confirmationCode(view.paymentId),
              authorizedAt: view.authorizedAt,
              receiptHref: receiptHref(token, lang),
            },
            lang,
          ),
        );
        return;
      case 'processing':
        sendHtml(res, 200, renderProcessingPage(lang, payHref(token, lang), true));
        return;
      case 'closed':
        sendHtml(res, 409, renderClosedPage(view.reason, lang));
        return;
    }
  }

  private sendError(res: FastifyReply, token: string, lang: PayLanguage, err: unknown): void {
    const message = (err as Error).message || 'Error';
    // Logueamos detalles técnicos pero NO los mostramos al cliente
    this.logger.warn(`/pay/${token} failed: ${message}`);
    sendHtml(res, 409, renderErrorPage(payErrorKey(message), lang));
  }

  private statementName(): string | null {
    const name = this.config.get<string>('PAY_STATEMENT_NAME')?.trim();
    return name ? name : null;
  }
}

function sendHtml(res: FastifyReply, status: number, html: string): void {
  res
    .status(status)
    .header('Content-Type', 'text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .send(html);
}
