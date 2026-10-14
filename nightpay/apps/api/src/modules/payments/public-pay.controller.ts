import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Body, Controller, Get, Headers, HttpCode, Inject, Logger, Param, Post, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { Public } from '../../common/decorators/public.decorator';
import { PaymentsService } from './payments.service';
import { WalletChargesService } from '../wallets/wallet-charges.service';
import { confirmationCode, type CheckoutChoice, type PayRedirect } from './pay-redirect';
import { detectPayDevice } from './pay-device';
import { PAY_TEXT, payErrorKey, resolveLanguage, type PayLanguage } from './pay-i18n';
import { PIN_PROBLEM_TEXT, pinProblem } from '../wallets/wallet-pin';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import {
  payHref,
  receiptHref,
  walletHref,
  pinAction,
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
/** El PIN que elige el cliente en "Pagado" tras recargar su saldo. */
const PinFormSchema = z.object({
  pin: z.string().trim(),
  pin2: z.string().trim(),
  lang: z.enum(['es', 'en']).optional(),
});

const CheckoutFormSchema = z.object({
  tip: z.coerce.number().int().min(0).max(100_000).default(0),
  method: z
    .enum(['wallet', 'card', ''])
    .optional()
    .transform((m) => (m === 'wallet' || m === 'card' ? m : null)),
  lang: z.enum(['es', 'en']).optional(),
});

/** La cookie de "este navegador pagó" dura lo que una noche larga y algo más. */
const WALLET_CLAIM_MAX_AGE_S = 7 * 24 * 3600;

/**
 * Nombre de la cookie que prueba que ESTE navegador hizo el pago de este
 * cobro. Su valor es aleatorio y propio de cada navegador; el intento de cobro
 * guarda su huella, y la página "Pagado" solo enseña el enlace del saldo al
 * navegador del intento que aprobó el banco (con ese enlace se aceptan
 * cobros: el personal que abra el mismo QR no debe verlo).
 */
export function walletClaimCookieName(secret: string, payToken: string): string {
  const mac = createHmac('sha256', secret).update(`wallet-claim:${payToken}`).digest('base64url');
  return `npw_${mac.slice(0, 22)}`;
}

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
  private readonly charges: WalletChargesService;

  constructor(
    @Inject(PaymentsService) payments: PaymentsService,
    @Inject(ConfigService) config: ConfigService,
    @Inject(WalletChargesService) charges: WalletChargesService,
  ) {
    this.payments = payments;
    this.config = config;
    this.charges = charges;
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
    const hidden = Boolean(view?.walletToken) && !this.hasWalletClaim(res, view?.qrToken ?? '', view?.walletClaimHash ?? null);
    const shown = hidden && view ? { ...view, walletToken: null } : view;
    sendHtml(res, 200, renderResultView(shown, lang, refreshUrl, hidden));
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
    // La cookie de este navegador: la que ya tenía para este cobro o una nueva.
    const claim = this.claimValue(res, token) ?? randomBytes(32).toString('base64url');
    const choice: CheckoutChoice = {
      tipCents: parsed.data.tip,
      method: parsed.data.method,
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
      case 'paid': {
        const payer = Boolean(view.walletToken) && this.hasWalletClaim(res, token, view.walletClaimHash);
        const pinState = (res as { request?: { query?: { pin?: unknown } } }).request?.query?.pin;
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
              walletHref: payer && view.walletToken ? walletHref(view.walletToken, lang) : null,
              walletElsewhere: Boolean(view.walletToken) && !payer,
              // Solo en el móvil que pagó: su código y, si aún no tiene, elegir su PIN.
              wallet:
                payer && view.walletCode
                  ? {
                      code: view.walletCode,
                      hasPin: view.walletHasPin,
                      pinAction: pinAction(token),
                      pinSaved: pinState === 'ok',
                      pinError: typeof pinState === 'string' && pinState !== 'ok' ? pinErrorText(pinState, lang) : null,
                    }
                  : null,
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

  /**
   * El cliente elige su PIN en "Pagado", en su propio móvil (nadie del local lo
   * ve). Solo el navegador que pagó la recarga y solo si aún no tiene PIN; un
   * formulario de otra web no sirve (comprobamos de dónde viene).
   */
  @Public()
  @Post(':token/pin')
  @HttpCode(200)
  @IpRateLimit({ max: 10, windowSec: 60, scope: 'pay-pin' })
  async choosePin(
    @Param('token') token: string,
    @Body() body: unknown,
    @Headers('origin') origin: string | undefined,
    @Headers('host') host: string | undefined,
    @Headers('accept-language') acceptLanguage: string | undefined,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const parsed = PinFormSchema.safeParse(body ?? {});
    const lang = resolveLanguage(parsed.success ? parsed.data.lang : undefined, acceptLanguage);
    const back = (state: string): void => {
      res
        .status(303)
        .header('Location', `/pay/${encodeURIComponent(token)}?lang=${lang}&pin=${state}`)
        .header('Cache-Control', 'no-store')
        .send();
    };
    if (origin && !sameHost(origin, host)) {
      sendHtml(res, 403, renderErrorPage('generic', lang));
      return;
    }
    try {
      const view = await this.payments.getPayPage(token);
      if (view.kind !== 'paid' || !view.walletToken || !this.hasWalletClaim(res, token, view.walletClaimHash)) {
        sendHtml(res, 403, renderErrorPage('generic', lang));
        return;
      }
      if (!parsed.success) return back('format');
      if (parsed.data.pin !== parsed.data.pin2) return back('mismatch');
      const problem = pinProblem(parsed.data.pin);
      if (problem) return back(problem);
      await this.charges.setPinByWalletToken(view.walletToken, parsed.data.pin);
      return back('ok');
    } catch (err) {
      this.logger.warn(`/pay/${token.slice(0, 4)}…/pin: ${(err as Error).message}`);
      return back('error');
    }
  }

  private sendError(res: FastifyReply, token: string, lang: PayLanguage, err: unknown): void {
    const message = (err as Error).message || 'Error';
    // Logueamos detalles técnicos pero NO los mostramos al cliente
    this.logger.warn(`/pay/${token.slice(0, 4)}… failed: ${message}`);
    sendHtml(res, 409, renderErrorPage(payErrorKey(message), lang));
  }

  private walletClaimName(payToken: string): string {
    return walletClaimCookieName(this.config.get<string>('COOKIE_SECRET') ?? '', payToken);
  }

  /** Path=/pay: también la recibe la vuelta del banco (/pay/result). */
  private setWalletClaim(res: FastifyReply, payToken: string, value: string): void {
    // SameSite=None: el banco devuelve al cliente desde otro sitio.
    const site = process.env.NODE_ENV === 'production' ? 'Secure; SameSite=None' : 'SameSite=Lax';
    res.header(
      'Set-Cookie',
      `${this.walletClaimName(payToken)}=${value}; Path=/pay; Max-Age=${WALLET_CLAIM_MAX_AGE_S}; HttpOnly; ${site}`,
    );
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

  private statementName(): string | null {
    const name = this.config.get<string>('PAY_STATEMENT_NAME')?.trim();
    return name ? name : null;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sendHtml(res: FastifyReply, status: number, html: string): void {
  res
    .status(status)
    .header('Content-Type', 'text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .send(html);
}

/** Por qué no se guardó el PIN (vuelve a "Pagado" con ?pin=…). */
function pinErrorText(state: string, lang: PayLanguage): string {
  const es: Record<string, string> = {
    mismatch: PAY_TEXT.es.pinMismatch,
    format: PIN_PROBLEM_TEXT.format,
    obvious: PIN_PROBLEM_TEXT.obvious,
  };
  const en: Record<string, string> = {
    mismatch: PAY_TEXT.en.pinMismatch,
    format: 'The PIN is 4 digits',
    obvious: 'That PIN is too easy to guess: choose another one',
  };
  const fallback = lang === 'en' ? 'Your PIN could not be saved. Please try again.' : 'No se ha podido guardar el PIN. Inténtalo otra vez.';
  return (lang === 'en' ? en : es)[state] ?? fallback;
}

/** El formulario viene de nuestra propia página (Origin "null" o de otra web, no). */
function sameHost(origin: string, host: string | undefined): boolean {
  try {
    return Boolean(host) && new URL(origin).host === host;
  } catch {
    return false;
  }
}

