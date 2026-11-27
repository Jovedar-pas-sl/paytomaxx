import { createHash, randomBytes } from 'node:crypto';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Inject,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CLIENT_HINTS_ACCEPT_CH, requestDevice } from '../../common/http/client-device';
import { z } from 'zod';
import { Public } from '../../common/decorators/public.decorator';
import { PaymentsService } from './payments.service';
import { WalletChargesService } from '../wallets/wallet-charges.service';
import { WalletPasskeysService } from '../wallets/wallet-passkeys.service';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { PAID_STATES, confirmationCode, withChosenTip, type CheckoutChoice, type PayRedirect } from './pay-redirect';
import { detectPayDevice, type PayDevice } from './pay-device';
import { PAY_TEXT, payErrorKeyOf, type PayLanguage } from './pay-i18n';
import { PAY_LANGUAGES, customerLanguage, suggestedLanguage } from './customer-lang';
import {
  payHref,
  receiptHref,
  walletHref,
  walletReturnHref,
  payBase,
  renderBusyPage,
  renderCheckoutForm,
  renderChoosePage,
  renderClosedPage,
  renderErrorPage,
  renderPaidPage,
  renderProcessingPage,
  renderNoticePage,
  renderReceiptPage,
  renderResultView,
  receiptMailState,
  type ReceiptMailState,
} from './public-pay.pages';
import { walletClaimCookieName, walletClaimSetCookie } from './wallet-claim';
import { MIN_RETRY_S, PayPageFilter } from './pay-page.filter';
import { isDatabaseBusy } from '../../common/filters/problem-details.filter';
import { RedsysReturnService } from './redsys-return.service';
import { renderCheckingPage } from './pay-checking-page';
import { PayStatusService, isPayLookupKey, type PayStatusContext } from './pay-status.service';
import { langHrefWith, type LangHref } from './customer-chrome';
import { giftShareHref, walletWelcomeHref } from '../home-topup/home-topup-rules';

/**
 * Páginas GET de /pay: fuera del límite global (global-rate-limit.ts) y con
 * este, holgado: el «Comprobando» se refresca cada 3-5 s y en el local muchos
 * clientes comparten el wifi. Pasado, una página que espera (PayPageFilter).
 */
const PAY_PAGE_LIMIT = { max: 600, windowSec: 60, scope: 'pay-page', failOpen: true } as const;

/**
 * El estado del pago de «Comprobando el pago» (JSON): fuera del límite global
 * y del de las páginas. Cada cobro tiene su cupo desde la IP (perKey: unas 20
 * consultas por minuto de una página abierta, con margen para dos pestañas y
 * recargas) y la IP uno alto: 30–50 clientes tras el wifi del local caben de
 * sobra. Pasado, un 429 en JSON (la página espera, no se va).
 */
const PAY_STATUS_BY_TOKEN = {
  max: 3_000,
  windowSec: 60,
  scope: 'pay-status',
  failOpen: true,
  perKey: { param: 'token', max: 120 },
} as const;
const PAY_STATUS_BY_ORDER = { ...PAY_STATUS_BY_TOKEN, perKey: { query: 'op', max: 120 } } as const;
import { checkedPin } from '../wallets/client-pin';
import { EmailService } from '../../common/email/email.service';
import { RECEIPT_EMAIL_MAX, receiptEmail } from './receipt-email';

/** Formulario de la página de pago. `method` vacío = sin preferencia. */
const CheckoutFormSchema = z.object({
  tip: z.coerce.number().int().min(0).max(100_000).default(0),
  method: z
    .enum(['wallet', 'card', ''])
    .optional()
    .transform((m) => (m === 'wallet' || m === 'card' ? m : null)),
  lang: z.enum(PAY_LANGUAGES as unknown as [PayLanguage, ...PayLanguage[]]).optional(),
});

/**
 * El justificante por correo (idea 68): una sola dirección (zod; llamarlo
 * `email` hace que sentry-scrub.ts lo tape) y el idioma de la página.
 */
const ReceiptEmailSchema = z.object({ email: z.string().trim().max(254).email() });

/**
 * Justificante por correo: 20 envíos cada 10 min desde una IP (la wifi del
 * local es una sola IP), sin dejar pasar si Redis no responde (cada uno es un
 * correo de verdad). Pasado, la página que espera (PayPageFilter).
 */
const RECEIPT_EMAIL_LIMIT = { max: 20, windowSec: 600, scope: 'pay-receipt-email' } as const;

export { walletClaimCookieName } from './wallet-claim';

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
 *  - GET  /pay/:token/receipt  → justificante, solo si está pagado (los 4
 *                                últimos dígitos, solo al navegador que pagó).
 *  - POST /pay/:token/receipt/email → el justificante por correo (solo quien
 *                                pagó, con el correo configurado; 303 de vuelta).
 *  - GET  /pay/:token/status   → el estado del pago en JSON para «Comprobando
 *  - GET  /pay/result/status?op=…  el pago» (pay-status.ts; sin caché).
 *
 * En español, inglés, francés o portugués: español por defecto (nunca el
 * idioma del móvil); el que elige el cliente (?lang=) queda en su cookie
 * (customer-lang.ts). Textos discretos, sin nombres internos.
 */
@Controller('pay')
export class PublicPayController {
  private readonly logger = new Logger(PublicPayController.name);
  private readonly payments: PaymentsService;
  private readonly config: ConfigService;
  private readonly charges: WalletChargesService;
  private readonly passkeys: WalletPasskeysService;
  private readonly redsysReturn: RedsysReturnService;
  private readonly status: PayStatusService | null;
  private readonly email: EmailService | null;

  constructor(
    @Inject(PaymentsService) payments: PaymentsService,
    @Inject(ConfigService) config: ConfigService,
    @Inject(WalletChargesService) charges: WalletChargesService,
    @Inject(WalletPasskeysService) passkeys: WalletPasskeysService,
    @Inject(RedsysReturnService) redsysReturn: RedsysReturnService,
    @Inject(PayStatusService) status?: PayStatusService,
    @Inject(EmailService) email?: EmailService,
  ) {
    this.payments = payments;
    this.config = config;
    this.charges = charges;
    this.passkeys = passkeys;
    this.redsysReturn = redsysReturn;
    this.status = status ?? null;
    this.email = email ?? null;
  }

  /** «Comprobando el pago» por la vuelta del banco: el estado en JSON, sin caché. */
  @Public()
  @Get('result/status')
  @IpRateLimit(PAY_STATUS_BY_ORDER)
  async resultStatus(@Query('op') op: string | undefined, @Res() res: FastifyReply): Promise<void> {
    const ctx = op && this.status ? await this.status.byOrder(op) : null;
    sendJson(res, ctx ? 200 : 404, ctx ? ctx.view : { message: 'Pago no encontrado' });
  }

  /** «Comprobando el pago» por el QR: el estado en JSON (otherPayer con la cookie de este navegador), sin caché. */
  @Public()
  @Get(':token/status')
  @IpRateLimit(PAY_STATUS_BY_TOKEN)
  async tokenStatus(@Param('token') token: string, @Res() res: FastifyReply): Promise<void> {
    // Un token sin buena pinta: 404 sin leer cookies ni la base de datos.
    const ctx = this.status && isPayLookupKey(token) ? await this.status.byToken(token, this.viewerClaimHash(res, token)) : null;
    sendJson(res, ctx ? 200 : 404, ctx ? ctx.view : { message: 'Pago no encontrado' });
  }

  /**
   * Vuelta del cliente desde la página de Yavin (return_url_success /
   * return_url_cancelled). Yavin añade el carrito (cartId) a la URL: se va a
   * /pay/result?op=<carrito>, que enseña el estado REAL del cobro (lo que diga
   * la URL no paga nada). También con YAVIN_ENABLED apagado: el cliente de un
   * enlace ya abierto tiene que poder volver.
   */
  @Public()
  @Get('yavin/return')
  @IpRateLimit(PAY_PAGE_LIMIT)
  yavinReturn(
    @Query('cartId') cartId: string | undefined,
    @Query('lang') langQuery: string | undefined,
    @Res() res: FastifyReply,
  ): void {
    // shortcut: el nombre del parámetro (cartId) solo se vio en un resumen de la documentación.
    const op = isPayLookupKey(cartId) ? cartId : '';
    const lang = PAY_LANGUAGES.includes(langQuery as PayLanguage) ? `&lang=${langQuery}` : '';
    redirectTo(res, `/pay/result?op=${encodeURIComponent(op)}${lang}`);
  }

  @Public()
  @Get('result')
  @IpRateLimit(PAY_PAGE_LIMIT)
  @UseFilters(new PayPageFilter())
  async paymentResult(
    @Query('op') op: string | undefined,
    @Query('lang') langQuery: string | undefined,
    @Headers('cookie') cookies: string | undefined,
    @Res() res: FastifyReply,
    @Query() query: Record<string, unknown> = {},
  ): Promise<void> {
    const result = await this.redsysReturn.process(op, query);
    const lang = this.language(res, langQuery, cookies);
    if (result === 'error') {
      // La vuelta puede ser la única prueba: reintentarla hasta guardarla.
      const retry = new URLSearchParams({ op: op ?? '', lang });
      for (const name of ['Ds_SignatureVersion', 'Ds_MerchantParameters', 'Ds_Signature']) {
        const value = query[name] ?? query[name.toLowerCase()];
        if (typeof value === 'string') retry.set(name, value);
      }
      res.header('Referrer-Policy', 'no-referrer');
      sendHtml(res, 200, renderProcessingPage(lang, `/pay/result?${retry}`));
      return;
    }
    // `enviado`: la vuelta firmada del banco dice aprobado (aunque el cobro se cancelara antes).
    const view = op ? await this.payments.getResultView(op, { bankApproved: result === 'enviado' }) : null;
    // Recarga empezada en /w y pagada desde ese navegador: de vuelta a su saldo.
    if (
      view?.walletReturnToken &&
      PAID_STATES.has(view.status) &&
      this.hasWalletClaim(res, view.qrToken, view.walletClaimHash)
    ) {
      redirectTo(res, walletReturnHref(view.walletReturnToken, view.qrToken, lang));
      return;
    }
    // Saldo nuevo cargado desde casa, en el navegador que lo pagó: a su saldo, con la bienvenida.
    if (
      view?.walletFromHome &&
      view.walletToken &&
      PAID_STATES.has(view.status) &&
      this.hasWalletClaim(res, view.qrToken, view.walletClaimHash)
    ) {
      redirectTo(res, walletWelcomeHref(view.walletToken, view.qrToken, lang));
      return;
    }
    // Reservado pagado desde este navegador: de vuelta a la página del reservado.
    if (view?.reservation && PAID_STATES.has(view.status) && this.hasWalletClaim(res, view.qrToken, view.approvedClaimHash ?? null)) {
      const back = await this.payments.reservationManageToken(view.paymentId);
      if (back) {
        redirectTo(res, `/reservas/${encodeURIComponent(back)}?pagado=1`);
        return;
      }
    }
    // Regalo pagado desde este navegador: «Comparte tu regalo» (nunca el saldo).
    if (view?.gift && PAID_STATES.has(view.status) && this.hasWalletClaim(res, view.qrToken, view.approvedClaimHash ?? null)) {
      const gift = await this.payments.giftToken(view.paymentId);
      if (gift) {
        redirectTo(res, giftShareHref(gift, lang));
        return;
      }
    }
    const refreshUrl = `/pay/result?op=${encodeURIComponent(op ?? '')}&lang=${lang}`;
    // Esperando al banco o sin su confirmación: «Comprobando el pago», que se pone al día sola.
    if (op && view && !PAID_STATES.has(view.status) && view.attemptStatus !== 'DENIED') {
      const ctx = this.status ? await this.status.byOrder(op) : null;
      if (ctx && (ctx.view.state === 'processing' || ctx.view.state === 'unconfirmed')) {
        const statusUrl = `/pay/result/status?op=${encodeURIComponent(op)}`;
        sendHtml(res, 200, this.checkingPage(ctx, lang, statusUrl, refreshUrl, langHrefWith('/pay/result', { op })));
        return;
      }
    }
    const hidden = Boolean(view?.walletToken) && !this.hasWalletClaim(res, view?.qrToken ?? '', view?.walletClaimHash ?? null);
    const shown = hidden && view ? { ...view, walletToken: null } : view;
    // «Pagado» lima solo en el navegador del intento aprobado; en los demás, «Ya pagado».
    const viewerPaid = view ? this.hasWalletClaim(res, view.qrToken, view.approvedClaimHash ?? null) : false;
    const topUp = Boolean(view?.walletToken || view?.walletReturnToken);
    sendHtml(res, 200, renderResultView(shown, lang, refreshUrl, { walletElsewhere: hidden, viewerPaid, topUp }));
  }

  @Public()
  @Get(':token/receipt')
  @IpRateLimit(PAY_PAGE_LIMIT)
  @UseFilters(new PayPageFilter())
  async receipt(
    @Param('token') token: string,
    @Query('lang') langQuery: string | undefined,
    @Headers('cookie') cookies: string | undefined,
    @Res() res: FastifyReply,
    // Lo que pasó con el último envío por correo (303 del POST): solo se pinta, no reenvía nada.
    @Query('correo') mailQuery?: string,
  ): Promise<void> {
    const lang = this.language(res, langQuery, cookies);
    const receipt = await this.payments.getReceipt(token);
    if (!receipt) {
      sendHtml(res, 404, renderErrorPage('notFound', lang));
      return;
    }
    // Quien pagó (la cookie del intento APROBADO, nunca la del saldo): ve los 4
    // últimos dígitos y puede pedírselo por correo. Cualquier otro, sin datos personales.
    const viewerPaid = this.hasWalletClaim(res, token, receipt.approvedClaimHash ?? null);
    const { approvedClaimHash: _claim, cardLast4, ...rest } = receipt;
    const shown = { ...rest, cardLast4: viewerPaid ? (cardLast4 ?? null) : null };
    const emailOn = viewerPaid && this.emailEnabled();
    // El formulario del correo vuelve a esta página con su Origin (no «null»): same-origin, nunca a otra web.
    res.header('Referrer-Policy', 'same-origin');
    sendHtml(
      res,
      200,
      renderReceiptPage(shown, {
        lang,
        statementName: this.statementName(),
        backHref: payHref(token, lang),
        emailAction: emailOn ? `${payBase(token)}/receipt/email` : null,
        mail: emailOn ? receiptMailState(mailQuery) : null,
      }),
    );
  }

  /**
   * «Enviármelo por correo» (idea 68), un formulario normal (también sin JS):
   * vuelve (303) al justificante con ?correo=enviado|error|tope|mal. Nada se
   * envía (403) desde otra web (la cookie es SameSite=None), sin pagar o sin la
   * cookie del intento aprobado. La dirección no se guarda: solo se usa para
   * este envío; queda apuntado que se envió (para el tope de 3). Si el correo
   * falla, la página sigue (dice que no se pudo).
   */
  @Public()
  @Post(':token/receipt/email')
  @IpRateLimit(RECEIPT_EMAIL_LIMIT)
  @UseFilters(new PayPageFilter())
  async emailReceipt(
    @Param('token') token: string,
    @Body() body: unknown,
    @Headers('cookie') cookies: string | undefined,
    @Headers('host') host: string | undefined,
    @Headers('origin') origin: string | undefined,
    @Headers('sec-fetch-site') fetchSite: string | undefined,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const form = (body && typeof body === 'object' ? body : {}) as { email?: unknown; lang?: unknown };
    const lang = this.language(res, PAY_LANGUAGES.includes(form.lang as PayLanguage) ? form.lang : undefined, cookies);
    const back = (state: ReceiptMailState): void =>
      redirectTo(res, `${payBase(token)}/receipt?lang=${lang}&correo=${state}`);
    const receipt = fromOurPage(origin, host, fetchSite) ? await this.payments.getReceipt(token) : null;
    if (!receipt || !this.hasWalletClaim(res, token, receipt.approvedClaimHash ?? null)) {
      sendHtml(res, 403, renderNoticePage(lang, PAY_TEXT[lang].receipt.emailForbidden, 'warn', `${payBase(token)}/receipt?lang=${lang}`));
      return;
    }
    if (!this.emailEnabled()) {
      back('error');
      return;
    }
    const parsed = ReceiptEmailSchema.safeParse({ email: form.email });
    if (!parsed.success) {
      back('mal');
      return;
    }
    try {
      if ((await this.payments.receiptEmailsSent(receipt.paymentId)) >= RECEIPT_EMAIL_MAX) {
        back('tope');
        return;
      }
      const mail = receiptEmail(receipt, lang);
      const sent = await this.email!.send({ to: parsed.data.email, ...mail });
      if (!sent.delivered) {
        back('error');
        return;
      }
      // Solo cuenta lo que Resend aceptó. Si el apunte falla, el correo ya salió: «Enviado» igual.
      await this.payments.recordReceiptEmailed(receipt.paymentId, lang).catch((err: unknown) => {
        this.logger.warn(`/pay/${token.slice(0, 4)}…: justificante enviado sin apuntar: ${(err as Error).message}`);
      });
      back('enviado');
    } catch (err) {
      this.logger.warn(`/pay/${token.slice(0, 4)}…: justificante por correo sin enviar: ${(err as Error).message}`);
      back('error');
    }
  }

  @Public()
  @Get(':token/checkout')
  @IpRateLimit(PAY_PAGE_LIMIT)
  @UseFilters(new PayPageFilter())
  async checkout(
    @Param('token') token: string,
    @Query('op') op: string | undefined,
    @Query('lang') langQuery: string | undefined,
    @Headers('cookie') cookies: string | undefined,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const lang = this.language(res, langQuery, cookies);
    const form = op ? await this.payments.getCheckoutForm(token, op) : null;
    if (form?.kind !== 'form') {
      res.status(303).header('Location', payHref(token, lang)).header('Cache-Control', 'no-store').send();
      return;
    }
    sendHtml(res, 200, renderCheckoutForm(form.action, form.fields, lang, payHref(token, lang), this.bankStatementName()));
  }

  @Public()
  @Get(':token')
  @IpRateLimit(PAY_PAGE_LIMIT)
  @UseFilters(new PayPageFilter())
  async payPage(
    @Param('token') token: string,
    @Query('lang') langQuery: string | undefined,
    @Headers('cookie') cookies: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
    @Res() res: FastifyReply,
    // La propina que eligió en la pantalla de la barra (?tip=): sale marcada.
    @Query('tip') tipQuery?: string,
    // El idioma de su móvil: no cambia la página, solo se le ofrece (idea 71).
    @Headers('accept-language') acceptLanguage?: string,
  ): Promise<void> {
    const lang = this.language(res, langQuery, cookies);
    try {
      const view = withChosenTip(await this.payments.getPayPage(token), tipQuery);
      await this.send(res, token, lang, view, userAgent, {
        suggest: suggestedLanguage(acceptLanguage, langQuery, cookies),
        // Los enlaces de idioma conservan esa propina (solo si son cifras).
        ...(tipQuery && /^[0-9]{1,6}$/.test(tipQuery) ? { langHref: langHrefWith(payBase(token), { tip: tipQuery }) } : {}),
      });
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
    @Headers('cookie') cookies: string | undefined,
    @Res() res: FastifyReply,
    @Req() req?: FastifyRequest,
  ): Promise<void> {
    const parsed = CheckoutFormSchema.safeParse(body ?? {});
    const lang = this.language(res, parsed.success ? parsed.data.lang : undefined, cookies);
    if (!parsed.success) {
      sendHtml(res, 400, renderErrorPage('generic', lang));
      return;
    }
    // La cookie de este navegador: la que ya tenía para este cobro o una nueva.
    const claim = this.claimValue(res, token) ?? randomBytes(32).toString('base64url');
    const choice: CheckoutChoice = {
      tipCents: parsed.data.tip,
      // Con el botón directo apagado, una página vieja que aún pida xpay va al banco sin preferencia.
      method: parsed.data.method === 'wallet' && !this.directWallet() ? null : parsed.data.method,
      language: lang,
      claimHash: sha256(claim),
      // El móvil del cliente que paga (detalle del pago).
      ...(req ? { device: requestDevice(req) } : {}),
    };
    try {
      const view = await this.payments.startCheckout(token, choice);
      if (view.kind === 'checkout' || view.kind === 'form' || view.kind === 'redirect') {
        this.setWalletClaim(res, token, claim);
      }
      await this.send(res, token, lang, view, undefined);
    } catch (err) {
      this.sendError(res, token, lang, err);
    }
  }

  private async send(
    res: FastifyReply,
    token: string,
    lang: PayLanguage,
    view: PayRedirect,
    userAgent: string | undefined,
    /** Solo al abrir la página de pago (GET): la franja de idioma y sus enlaces. */
    chrome: { suggest?: PayLanguage | null; langHref?: LangHref } = {},
  ): Promise<void> {
    switch (view.kind) {
      case 'choose':
        sendHtml(
          res,
          200,
          renderChoosePage(view, {
            token,
            lang,
            device: this.payDevice(userAgent),
            statementName: this.statementName(),
            now: new Date(),
            ...chrome,
          }),
        );
        return;
      case 'bitcoin':
        // Factura de bitcoin abierta: su página (BtcpayPayController).
        res
          .status(303)
          .header('Location', `/pay/${encodeURIComponent(token)}/bitcoin?lang=${lang}`)
          .header('Cache-Control', 'no-store')
          .send();
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
        sendHtml(res, 200, renderCheckoutForm(view.action, view.fields, lang, payHref(token, lang), this.bankStatementName()));
        return;
      case 'paid': {
        const claimed = this.hasWalletClaim(res, token, view.walletClaimHash);
        // Recarga empezada en /w: el navegador que la empezó vuelve a su saldo
        // (con el «Pagado» allí); otro navegador ve solo el «Pagado».
        if (view.walletReturnToken && claimed) {
          redirectTo(res, walletReturnHref(view.walletReturnToken, token, lang));
          return;
        }
        // Saldo nuevo cargado desde casa: el navegador que lo pagó va a su saldo (con la bienvenida).
        if (view.walletFromHome && view.walletToken && claimed) {
          redirectTo(res, walletWelcomeHref(view.walletToken, token, lang));
          return;
        }
        // Reservado pagado desde este navegador (también con bitcoin, que vuelve aquí desde su QR):
        // a la página del reservado, como al volver del banco (/pay/result).
        if (view.reservation && this.hasWalletClaim(res, token, view.approvedClaimHash ?? null)) {
          const back = await this.payments.reservationManageToken(view.paymentId);
          if (back) {
            redirectTo(res, `/reservas/${encodeURIComponent(back)}?pagado=1`);
            return;
          }
        }
        // Regalo pagado desde este navegador (también con bitcoin): «Comparte tu regalo».
        if (view.gift && this.hasWalletClaim(res, token, view.approvedClaimHash ?? null)) {
          const gift = await this.payments.giftToken(view.paymentId);
          if (gift) {
            redirectTo(res, giftShareHref(gift, lang));
            return;
          }
        }
        const payer = Boolean(view.walletToken) && claimed;
        sendHtml(
          res,
          200,
          renderPaidPage(
            {
              amountCents: view.amountCents,
              tipCents: view.tipCents,
              serviceFeeCents: view.serviceFeeCents ?? 0,
              currency: view.currency,
              code: confirmationCode(view.paymentId),
              authorizedAt: view.authorizedAt,
              receiptHref: receiptHref(token, lang),
              walletHref: payer && view.walletToken ? walletHref(view.walletToken, lang) : null,
              walletElsewhere: Boolean(view.walletToken) && !payer,
              // Solo en el móvil que pagó la recarga que creó el saldo.
              wallet: payer && view.walletCode ? { hasFaceId: view.walletHasFaceId, base: payBase(token) } : null,
              // Un /pay reenviado a otro móvil ve «Ya pagado» en gris, nunca el lima.
              viewerPaid: this.hasWalletClaim(res, token, view.approvedClaimHash ?? null),
              topUp: Boolean(view.walletToken || view.walletReturnToken),
              // A quién se pagó, qué y cómo (idea 62).
              to: view.venueName,
              concept: view.concept,
              cardBrand: view.cardBrand,
              payMethod: view.payMethod,
            },
            lang,
          ),
        );
        return;
      }
      case 'processing':
      case 'closed': {
        // Esperando al banco o sin su confirmación: «Comprobando el pago», que se pone al día sola.
        if (view.kind === 'processing' || view.reason === 'unconfirmed') {
          const ctx = this.status ? await this.status.byToken(token, this.viewerClaimHash(res, token)) : null;
          if (ctx && (ctx.view.state === 'processing' || ctx.view.state === 'unconfirmed')) {
            const page = payHref(token, lang);
            sendHtml(res, 200, this.checkingPage(ctx, lang, `/pay/${encodeURIComponent(token)}/status`, page, (l) => payHref(token, l)));
            return;
          }
        }
        if (view.kind === 'processing') sendHtml(res, 200, renderProcessingPage(lang, payHref(token, lang), true));
        else sendHtml(res, 409, renderClosedPage(view.reason, lang));
        return;
      }
    }
  }

  // ─── Recarga de saldo: activar Face ID o sumarla al saldo de siempre ─────
  // Solo el móvil que pagó (cookie del pago), desde nuestra página, y solo en
  // la recarga que creó el saldo (la vista no da el saldo en otras).

  @Public()
  @Post(':token/passkey/options')
  @HttpCode(200)
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'pay-passkey' })
  async walletPasskeyOptions(
    @Param('token') token: string,
    @Headers('host') host: string | undefined,
    @Headers('origin') origin: string | undefined,
    @Headers('sec-fetch-site') fetchSite: string | undefined,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<unknown> {
    const wallet = await this.payerWallet(token, res, host, origin, fetchSite);
    return this.passkeys.registrationOptions(wallet, host);
  }

  @Public()
  @Post(':token/passkey')
  @HttpCode(200)
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'pay-passkey' })
  async walletPasskeyRegister(
    @Param('token') token: string,
    @Body() body: { response?: unknown } | undefined,
    @Headers('host') host: string | undefined,
    @Headers('origin') origin: string | undefined,
    @Headers('sec-fetch-site') fetchSite: string | undefined,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<{ ok: true }> {
    const wallet = await this.payerWallet(token, res, host, origin, fetchSite);
    await this.passkeys.register(wallet.id, host, body?.response);
    return { ok: true };
  }

  @Public()
  @Post(':token/merge/challenge')
  @HttpCode(200)
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'pay-passkey' })
  async walletMergeChallenge(
    @Param('token') token: string,
    @Headers('host') host: string | undefined,
    @Headers('origin') origin: string | undefined,
    @Headers('sec-fetch-site') fetchSite: string | undefined,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<unknown> {
    const wallet = await this.payerWallet(token, res, host, origin, fetchSite);
    return this.passkeys.challenge(`merge:${wallet.id}`, host);
  }

  /** El cliente elige su PIN (para pagar sin sacar el móvil), en su móvil, tras recargar. */
  @Public()
  @Post(':token/pin')
  @HttpCode(200)
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'pay-passkey' })
  async walletPin(
    @Param('token') token: string,
    @Body() body: { pin?: unknown; pin2?: unknown } | undefined,
    @Headers('host') host: string | undefined,
    @Headers('origin') origin: string | undefined,
    @Headers('sec-fetch-site') fetchSite: string | undefined,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<{ ok: true }> {
    const pin = checkedPin(body);
    const wallet = await this.payerWallet(token, res, host, origin, fetchSite);
    await this.charges.setPinFromPayer(wallet.id, pin);
    return { ok: true };
  }

  /** "Sumar a mi saldo": su llave dice cuál es su saldo de siempre. */
  @Public()
  @Post(':token/merge')
  @HttpCode(200)
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'pay-passkey' })
  async walletMerge(
    @Param('token') token: string,
    @Body() body: { response?: unknown } | undefined,
    @Headers('host') host: string | undefined,
    @Headers('origin') origin: string | undefined,
    @Headers('sec-fetch-site') fetchSite: string | undefined,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<{ balanceCents: number }> {
    const wallet = await this.payerWallet(token, res, host, origin, fetchSite);
    const target = await this.passkeys.verify(`merge:${wallet.id}`, host, body?.response);
    return this.charges.mergeInto(wallet.id, target);
  }

  /** El saldo de la recarga que creó este cobro, si esta petición es del móvil que la pagó. */
  private async payerWallet(
    token: string,
    res: FastifyReply,
    host: string | undefined,
    origin: string | undefined,
    fetchSite: string | undefined,
  ): Promise<{ id: string; shortCode: string | null }> {
    // La cookie del pago es SameSite=None (vuelve del banco): solo si el
    // navegador dice que viene de nuestra página.
    const fromUs = origin ? sameHost(origin, host) : fetchSite === 'same-origin';
    const view = fromUs ? await this.payments.getPayPage(token) : null;
    if (
      !view ||
      view.kind !== 'paid' ||
      !view.walletToken ||
      !view.walletCode ||
      !this.hasWalletClaim(res, token, view.walletClaimHash)
    ) {
      throw new ForbiddenException({ message: 'Esto solo se puede hacer desde el móvil que pagó la recarga', code: 'PAYER_ONLY' });
    }
    return this.charges.walletRefByToken(view.walletToken);
  }

  /** «Comprobando el pago» con su estado de ahora (pay-checking-page.ts). */
  private checkingPage(ctx: PayStatusContext, lang: PayLanguage, statusUrl: string, finalUrl: string, langHref: LangHref): string {
    return renderCheckingPage({
      mode: ctx.view.state === 'unconfirmed' ? 'unconfirmed' : 'processing',
      view: ctx.view,
      lang,
      currency: ctx.currency,
      concept: ctx.concept,
      ref: ctx.ref,
      statementName: this.bankStatementName(),
      statusUrl,
      finalUrl,
      retryHref: payHref(ctx.qrToken, lang),
      saldoHref: ctx.saldoPayToken ? `/s/${encodeURIComponent(ctx.saldoPayToken)}?lang=${lang}` : null,
      langHref,
    });
  }

  /** La huella de la cookie de este navegador para este cobro (null si no la tiene). */
  private viewerClaimHash(res: FastifyReply, payToken: string): string | null {
    const value = this.claimValue(res, payToken);
    return value ? sha256(value) : null;
  }

  /**
   * El nombre con el que el cliente busca el cargo en su app del banco: el del
   * extracto (PAY_STATEMENT_NAME) o, si no está, el del comercio en la página
   * de Redsys (REDSYS_MERCHANT_NAME). Sin ninguno, la frase sin nombre.
   */
  private bankStatementName(): string | null {
    const merchant = this.config.get<string>('REDSYS_MERCHANT_NAME')?.trim();
    return this.statementName() ?? (merchant ? merchant : null);
  }

  /** El idioma de la página; si el cliente acaba de elegir otro (?lang=), se recuerda en su cookie. */
  private language(res: FastifyReply, query: unknown, cookies: string | undefined): PayLanguage {
    const { lang, setCookie } = customerLanguage(query, cookies);
    if (setCookie) res.header('Set-Cookie', setCookie);
    return lang;
  }

  private sendError(res: FastifyReply, token: string, lang: PayLanguage, err: unknown): void {
    // La base sin conexión libre (mucha gente pagando a la vez): la página que
    // espera y se recarga sola en la del cobro (un POST nunca se repite solo),
    // no un 409 de error (carga del 19-11-2026).
    if (isDatabaseBusy(err)) {
      this.logger.warn(`/pay/${token.slice(0, 4)}…: base sin conexión libre (${err.code}), «Hay mucha gente pagando»`);
      res.header('Retry-After', String(MIN_RETRY_S));
      sendHtml(res, 503, renderBusyPage(lang, payHref(token, lang), MIN_RETRY_S));
      return;
    }
    const message = (err as Error).message || 'Error';
    // Logueamos detalles técnicos pero NO los mostramos al cliente
    this.logger.warn(`/pay/${token.slice(0, 4)}… failed: ${message}`);
    sendHtml(res, 409, renderErrorPage(payErrorKeyOf(err), lang, payHref(token, lang)));
  }

  private cookieSecret(): string {
    return this.config.get<string>('COOKIE_SECRET') ?? '';
  }

  private walletClaimName(payToken: string): string {
    return walletClaimCookieName(this.cookieSecret(), payToken);
  }

  /** Path=/pay: también la recibe la vuelta del banco (/pay/result). */
  private setWalletClaim(res: FastifyReply, payToken: string, value: string): void {
    res.header('Set-Cookie', walletClaimSetCookie(this.cookieSecret(), payToken, value));
  }

  /** Valor de la cookie de este navegador para este cobro (si la tiene). */
  private claimValue(res: FastifyReply, payToken: string): string | null {
    const header = (res as { request?: { headers?: { cookie?: string } } }).request?.headers?.cookie ?? '';
    const prefix = `${this.walletClaimName(payToken)}=`;
    for (const part of header.split(';')) {
      const c = part.trim();
      if (!c.startsWith(prefix)) continue;
      const value = c.slice(prefix.length);
      if (/^[A-Za-z0-9_-]{43}$/.test(value)) return value;
    }
    return null;
  }

  /** ¿Es este navegador el que hizo el pago aprobado? */
  private hasWalletClaim(res: FastifyReply, payToken: string, claimHash: string | null): boolean {
    if (!claimHash) return false;
    const value = this.claimValue(res, payToken);
    return value !== null && sha256(value) === claimHash;
  }

  /** Sin el botón directo de Apple Pay / Google Pay (PAY_DIRECT_WALLET=false): un solo botón hacia el banco. */
  private payDevice(userAgent: string | undefined): PayDevice {
    const device = detectPayDevice(userAgent);
    return this.directWallet() ? device : { ...device, wallet: null };
  }

  /** PAY_DIRECT_WALLET (por defecto, sí): ConfigService da el booleano validado o, sin validar, el texto. */
  private directWallet(): boolean {
    const raw = this.config.get<boolean | string | undefined>('PAY_DIRECT_WALLET');
    return !(raw === false || raw === 'false' || raw === '0');
  }

  /** El correo (Resend) configurado: sin él, «Enviármelo por correo» ni sale. */
  private emailEnabled(): boolean {
    try {
      return this.email?.isEnabled() === true;
    } catch {
      return false;
    }
  }

  private statementName(): string | null {
    const name = this.config.get<string>('PAY_STATEMENT_NAME')?.trim();
    return name ? name : null;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function redirectTo(res: FastifyReply, location: string): void {
  res.status(303).header('Location', location).header('Cache-Control', 'no-store').send();
}

/** JSON del estado del pago: nunca en caché (cambia cada pocos segundos). */
function sendJson(res: FastifyReply, status: number, body: unknown): void {
  res
    .status(status)
    .header('Content-Type', 'application/json; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .send(JSON.stringify(body));
}

function sendHtml(res: FastifyReply, status: number, html: string): void {
  res
    .status(status)
    .header('Content-Type', 'text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    // Android: que mande el modelo y la versión en las peticiones siguientes (al pagar).
    .header('Accept-CH', CLIENT_HINTS_ACCEPT_CH)
    .send(html);
}

/**
 * Un formulario de nuestra página (el justificante por correo): con Origin,
 * el de este dominio; sin él (o «null»), Sec-Fetch-Site same-origin. Otra web
 * no puede enviarlo aunque el navegador lleve la cookie del pago (SameSite=None).
 */
function fromOurPage(origin: string | undefined, host: string | undefined, fetchSite: string | undefined): boolean {
  if (origin && origin !== 'null') return sameHost(origin, host);
  return fetchSite === 'same-origin';
}

/** La petición viene de nuestra propia página (Origin "null" o de otra web, no). */
function sameHost(origin: string, host: string | undefined): boolean {
  try {
    return Boolean(host) && new URL(origin).host === host;
  } catch {
    return false;
  }
}

