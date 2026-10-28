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
  Res,
  UseFilters,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { Public } from '../../common/decorators/public.decorator';
import { PaymentsService } from './payments.service';
import { WalletChargesService } from '../wallets/wallet-charges.service';
import { WalletPasskeysService } from '../wallets/wallet-passkeys.service';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { PAID_STATES, confirmationCode, type CheckoutChoice, type PayRedirect } from './pay-redirect';
import { detectPayDevice, type PayDevice } from './pay-device';
import { payErrorKeyOf, type PayLanguage } from './pay-i18n';
import { PAY_LANGUAGES, customerLanguage } from './customer-lang';
import {
  payHref,
  receiptHref,
  walletHref,
  walletReturnHref,
  payBase,
  renderCheckoutForm,
  renderChoosePage,
  renderClosedPage,
  renderErrorPage,
  renderPaidPage,
  renderProcessingPage,
  renderReceiptPage,
  renderResultView,
} from './public-pay.pages';
import { walletClaimCookieName, walletClaimSetCookie } from './wallet-claim';
import { PayPageFilter } from './pay-page.filter';

/**
 * Páginas GET de /pay: fuera del límite global (global-rate-limit.ts) y con
 * este, holgado: el «Comprobando» se refresca cada 3-5 s y en el local muchos
 * clientes comparten el wifi. Pasado, una página que espera (PayPageFilter).
 */
const PAY_PAGE_LIMIT = { max: 600, windowSec: 60, scope: 'pay-page', failOpen: true } as const;
import { checkedPin } from '../wallets/client-pin';

/** Formulario de la página de pago. `method` vacío = sin preferencia. */
const CheckoutFormSchema = z.object({
  tip: z.coerce.number().int().min(0).max(100_000).default(0),
  method: z
    .enum(['wallet', 'card', ''])
    .optional()
    .transform((m) => (m === 'wallet' || m === 'card' ? m : null)),
  lang: z.enum(PAY_LANGUAGES as unknown as [PayLanguage, ...PayLanguage[]]).optional(),
});

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
 *  - GET  /pay/:token/receipt  → justificante, solo si está pagado.
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

  constructor(
    @Inject(PaymentsService) payments: PaymentsService,
    @Inject(ConfigService) config: ConfigService,
    @Inject(WalletChargesService) charges: WalletChargesService,
    @Inject(WalletPasskeysService) passkeys: WalletPasskeysService,
  ) {
    this.payments = payments;
    this.config = config;
    this.charges = charges;
    this.passkeys = passkeys;
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
  ): Promise<void> {
    const lang = this.language(res, langQuery, cookies);
    const view = op ? await this.payments.getResultView(op) : null;
    // Recarga empezada en /w y pagada desde ese navegador: de vuelta a su saldo.
    if (
      view?.walletReturnToken &&
      PAID_STATES.has(view.status) &&
      this.hasWalletClaim(res, view.qrToken, view.walletClaimHash)
    ) {
      redirectTo(res, walletReturnHref(view.walletReturnToken, view.qrToken, lang));
      return;
    }
    const refreshUrl = `/pay/result?op=${encodeURIComponent(op ?? '')}&lang=${lang}`;
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
  ): Promise<void> {
    const lang = this.language(res, langQuery, cookies);
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
    sendHtml(res, 200, renderCheckoutForm(form.action, form.fields, lang, payHref(token, lang)));
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
  ): Promise<void> {
    const lang = this.language(res, langQuery, cookies);
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
    @Headers('cookie') cookies: string | undefined,
    @Res() res: FastifyReply,
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
    };
    try {
      const view = await this.payments.startCheckout(token, choice);
      if (view.kind === 'checkout' || view.kind === 'form' || view.kind === 'redirect') {
        this.setWalletClaim(res, token, claim);
      }
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
            device: this.payDevice(userAgent),
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
      case 'paid': {
        const claimed = this.hasWalletClaim(res, token, view.walletClaimHash);
        // Recarga empezada en /w: el navegador que la empezó vuelve a su saldo
        // (con el «Pagado» allí); otro navegador ve solo el «Pagado».
        if (view.walletReturnToken && claimed) {
          redirectTo(res, walletReturnHref(view.walletReturnToken, token, lang));
          return;
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
            },
            lang,
          ),
        );
        return;
      }
      case 'processing':
        sendHtml(res, 200, renderProcessingPage(lang, payHref(token, lang), true));
        return;
      case 'closed':
        sendHtml(res, 409, renderClosedPage(view.reason, lang));
        return;
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

  /** El idioma de la página; si el cliente acaba de elegir otro (?lang=), se recuerda en su cookie. */
  private language(res: FastifyReply, query: unknown, cookies: string | undefined): PayLanguage {
    const { lang, setCookie } = customerLanguage(query, cookies);
    if (setCookie) res.header('Set-Cookie', setCookie);
    return lang;
  }

  private sendError(res: FastifyReply, token: string, lang: PayLanguage, err: unknown): void {
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

function sendHtml(res: FastifyReply, status: number, html: string): void {
  res
    .status(status)
    .header('Content-Type', 'text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .send(html);
}

/** La petición viene de nuestra propia página (Origin "null" o de otra web, no). */
function sameHost(origin: string, host: string | undefined): boolean {
  try {
    return Boolean(host) && new URL(origin).host === host;
  } catch {
    return false;
  }
}

