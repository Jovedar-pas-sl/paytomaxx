import {
  Body,
  ConflictException,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply } from 'fastify';
import { Public } from '../../common/decorators/public.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { customerLanguage, resolveLanguage } from '../payments/customer-lang';
import { walletClaimSetCookie } from '../payments/wallet-claim';
import { WalletChargesService, codeHintOf, type ClientWalletState } from './wallet-charges.service';
import { WalletPasskeysService } from './wallet-passkeys.service';
import { WalletTopUpService } from './wallet-topup.service';
import { renderWalletPage } from './wallet-page';
import { checkedPin } from './client-pin';
import { walletViewSetCookies } from './wallet-view-session';
import { walletViewAccess, type WalletViewAccess } from './wallet-view-access';
import { renderWalletUnlockPage } from './wallet-unlock-page';
import { GoogleWalletService } from './google-wallet/google-wallet.service';

/**
 * Saldo NightPay — páginas del cliente (fuera de /v1). Sin cuenta: el enlace
 * con su token es la credencial (como el QR del cobro).
 *  - GET  /w/:token                          → página del saldo.
 *  - GET  /w/:token/state                    → estado (la página lo refresca).
 *  - POST /w/:token/passkey/options, /passkey → activar Face ID.
 *  - POST /w/:token/pin/challenge, /pin      → elegir PIN (si aún no tiene).
 *  - POST /w/:token/merge/challenge, /merge  → sumar este saldo al de su Face ID.
 *  - POST /w/:token/close/challenge, /close  → "Me voy: devolver mi saldo".
 *    Elegir PIN y «Me voy» con un saldo que tiene Face ID piden además su
 *    llave (el reto de /challenge, atado a `pin:` / `close:` y a este saldo):
 *    con solo el enlace no se le pone PIN para gastarlo con código + PIN.
 *  - POST /w/:token/topup/challenge, /topup  → «Recargar»: crea la recarga de
 *    este saldo (con su Face ID si lo tiene) y se paga en /pay/:token; al
 *    pagar, este navegador vuelve aquí con ?pagado=<cobro> (WalletTopUpService).
 *  - POST /w/:token/google-wallet            → guardar el saldo en Google Wallet
 *    (GoogleWalletController; el botón sale solo en Android y si está configurado).
 * Aquí no se paga: se paga escaneando el QR de la chica (/s/:token, con Face
 * ID) o con el código o la ficha y el PIN en el móvil de la chica.
 *
 * Límites por IP holgados: en un local muchos clientes comparten el wifi y la
 * página consulta su estado cada pocos segundos. El token (144 bits) no se
 * puede adivinar; el límite es contra abusos, no contra fuerza bruta.
 */
@Controller('w')
export class PublicWalletController {
  private readonly charges: WalletChargesService;
  private readonly passkeys: WalletPasskeysService;
  private readonly gwallet: GoogleWalletService;
  private readonly topUps: WalletTopUpService;
  private readonly config: ConfigService;

  constructor(
    @Inject(WalletChargesService) charges: WalletChargesService,
    @Inject(WalletPasskeysService) passkeys: WalletPasskeysService,
    @Inject(GoogleWalletService) gwallet: GoogleWalletService,
    @Inject(WalletTopUpService) topUps: WalletTopUpService,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.charges = charges;
    this.passkeys = passkeys;
    this.gwallet = gwallet;
    this.topUps = topUps;
    this.config = config;
  }

  /** Activar Face ID, paso 1 (con el enlace del saldo; solo si aún no tiene). */
  @Public()
  @Post(':token/passkey/options')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'wallet-passkey' })
  async passkeyOptions(@Param('token') token: string, @Headers('host') host: string | undefined): Promise<unknown> {
    return this.passkeys.registrationOptions(await this.charges.walletRefByToken(token), host);
  }

  /** Activar Face ID, paso 2: la respuesta de su móvil. */
  @Public()
  @Post(':token/passkey')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'wallet-passkey' })
  async passkeyRegister(
    @Param('token') token: string,
    @Body() body: { response?: unknown } | undefined,
    @Headers('host') host: string | undefined,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<ClientWalletState> {
    const wallet = await this.charges.walletRefByToken(token);
    await this.passkeys.register(wallet.id, host, body?.response);
    res.header('Set-Cookie', walletViewSetCookies(this.config.get<string>('COOKIE_SECRET') ?? '', { id: wallet.id, qrToken: token }));
    return this.charges.clientState(token);
  }

  /** Elegir PIN o «Me voy» con Face ID, paso 1: reto para su llave (solo si el saldo tiene Face ID). */
  @Public()
  @Post(':token/pin/challenge')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'wallet-pin' })
  async pinChallenge(@Param('token') token: string, @Headers('host') host: string | undefined): Promise<unknown> {
    return this.ownerChallenge(token, 'pin', host);
  }

  /**
   * Elegir PIN (para pagar sin sacar el móvil), desde la página del saldo.
   * Lo mismo que en el «Pagado» de la recarga: solo si aún no tiene PIN. Con
   * Face ID, solo desbloqueando el móvil del saldo (`response` del reto).
   */
  @Public()
  @Post(':token/pin')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'wallet-pin' })
  async pin(
    @Param('token') token: string,
    @Body() body: { pin?: unknown; pin2?: unknown; response?: unknown } | undefined,
    @Headers('host') host: string | undefined,
  ): Promise<ClientWalletState> {
    const pin = checkedPin(body);
    const wallet = await this.charges.walletRefByToken(token);
    await this.passkeys.assertOwner(wallet.id, `pin:${wallet.id}`, host, body?.response);
    await this.charges.setPinFromPayer(wallet.id, pin);
    return this.charges.clientState(token);
  }

  /** Sumar este saldo al de siempre, paso 1: reto para su llave (Face ID…). */
  @Public()
  @Post(':token/merge/challenge')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'wallet-merge' })
  async mergeChallenge(@Param('token') token: string, @Headers('host') host: string | undefined): Promise<unknown> {
    const wallet = await this.charges.walletRefByToken(token);
    return this.passkeys.challenge(`merge:${wallet.id}`, host);
  }

  /** Paso 2: su llave dice cuál es su saldo de siempre; este se suma a aquel. */
  @Public()
  @Post(':token/merge')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'wallet-merge' })
  async merge(
    @Param('token') token: string,
    @Body() body: { response?: unknown } | undefined,
    @Headers('host') host: string | undefined,
  ): Promise<{ balanceCents: number }> {
    const wallet = await this.charges.walletRefByToken(token);
    const target = await this.passkeys.verify(`merge:${wallet.id}`, host, body?.response);
    return this.charges.mergeInto(wallet.id, target);
  }

  /** «Recargar» con Face ID, paso 1: reto para su llave (solo si el saldo tiene Face ID). */
  @Public()
  @Post(':token/topup/challenge')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'wallet-topup-challenge' })
  async topUpChallenge(@Param('token') token: string, @Headers('host') host: string | undefined): Promise<unknown> {
    return this.topUps.challenge(token, host);
  }

  /**
   * «Recargar», paso 2: crea la recarga de este saldo y dice a dónde ir a
   * pagarla. Deja en /pay la cookie de vuelta: tras pagar, este navegador (y
   * no otro que abra el enlace de pago) vuelve aquí con su «Pagado».
   * Límite por IP más holgado que el resto de /w (el wifi del local lo
   * comparten muchos); el de verdad es el de cada saldo (WalletTopUpService).
   */
  @Public()
  @Post(':token/topup')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'wallet-topup' })
  async topUp(
    @Param('token') token: string,
    @Body() body: { amountCents?: unknown; key?: unknown; response?: unknown; lang?: unknown } | undefined,
    @Headers('host') host: string | undefined,
    @Headers('cookie') cookies: string | undefined,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<{ payUrl: string }> {
    const lang = resolveLanguage(typeof body?.lang === 'string' ? body.lang : undefined, cookies);
    const started = await this.topUps.start(
      token,
      { amountCents: body?.amountCents, key: body?.key, response: body?.response, lang },
      host,
    );
    const secret = this.config.get<string>('COOKIE_SECRET') ?? '';
    res.header('Set-Cookie', walletClaimSetCookie(secret, started.payToken, started.claim));
    return { payUrl: started.payUrl };
  }

  @Public()
  @Get(':token')
  @IpRateLimit({ max: 120, windowSec: 60, scope: 'wallet-page', failOpen: true })
  async page(
    @Param('token') token: string,
    @Query('lang') langQuery: string | undefined,
    @Res() res: FastifyReply,
    @Query('pagado') paidToken?: string,
    @Headers('cookie') cookies?: string,
  ): Promise<void> {
    // Español por defecto; el idioma que elige el cliente queda en su cookie.
    const { lang, setCookie } = customerLanguage(langQuery, cookies);
    if (setCookie) res.header('Set-Cookie', setCookie);
    const access = await this.viewAccess(token, cookies);
    if (!access.allowed) {
      const { shortCode } = await this.charges.walletRefByToken(token);
      res.status(200).header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')
        .send(renderWalletUnlockPage(`/w/${encodeURIComponent(token)}`, lang, { kind: 'locked', codeHint: shortCode ? codeHintOf(shortCode) : null, paidToken }));
      return;
    }
    if (access.renew) res.header('Set-Cookie', access.renew);
    // Ya no hay QR del código: para pagar, el cliente escanea el QR de la
    // chica y desbloquea su móvil (Face ID).
    const state = await this.charges.clientState(token);
    const [topUp, paid] = await Promise.all([this.topUps.options(token), this.topUps.paidProof(token, paidToken)]);
    res
      .status(200)
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .send(
        renderWalletPage(token, lang, state, {
          googleWallet: this.gwallet.enabled,
          topUp,
          paid,
        }),
      );
  }

  @Public()
  @Get(':token/state')
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 1500, windowSec: 60, scope: 'wallet-state', failOpen: true })
  async state(
    @Param('token') token: string,
    @Res({ passthrough: true }) res: FastifyReply,
    @Headers('cookie') cookies?: string,
  ): Promise<ClientWalletState> {
    const access = await this.viewAccess(token, cookies);
    if (!access.allowed) throw new UnauthorizedException({ message: 'Desbloquea tu saldo con tu teléfono.', code: 'WALLET_VIEW_REQUIRED' });
    // La página lo pide cada 3 s mientras se ve: eso es actividad y alarga la sesión.
    if (access.renew) res.header('Set-Cookie', access.renew);
    return this.charges.clientState(token);
  }

  @Public()
  @Post(':token/view/challenge')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 120, windowSec: 60, scope: 'wallet-view' })
  async viewChallenge(@Param('token') token: string, @Headers('host') host: string | undefined): Promise<unknown> {
    const wallet = await this.charges.walletRefByToken(token);
    if (!(await this.passkeys.hasPasskey(wallet.id))) throw new ConflictException({ message: 'Activa el desbloqueo desde tu enlace privado.', code: 'FACE_ID_NOT_SET' });
    return this.passkeys.challenge(`view:${wallet.id}`, host);
  }

  @Public()
  @Post(':token/view')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @IpRateLimit({ max: 120, windowSec: 60, scope: 'wallet-view' })
  async viewUnlock(@Param('token') token: string, @Headers('host') host: string | undefined, @Body() body: { response?: unknown } | undefined, @Res({ passthrough: true }) res: FastifyReply): Promise<{ url: string }> {
    const wallet = await this.charges.walletRefByToken(token);
    const owner = await this.passkeys.verify(`view:${wallet.id}`, host, body?.response);
    if (owner !== wallet.id) throw new ForbiddenException({ message: 'Usa la passkey de este saldo.', code: 'FACE_ID_WRONG' });
    res.header('Set-Cookie', walletViewSetCookies(this.config.get<string>('COOKIE_SECRET') ?? '', { id: wallet.id, qrToken: token }));
    return { url: `/w/${encodeURIComponent(token)}` };
  }

  private async viewAccess(token: string, cookies: string | undefined): Promise<WalletViewAccess> {
    return walletViewAccess({
      walletRefByToken: (value) => this.charges.walletRefByToken(value),
      hasPasskey: (id) => this.passkeys.hasPasskey(id),
      secret: this.config.get<string>('COOKIE_SECRET') ?? '',
    }, token, cookies);
  }

  @Public()
  @Post(':token/close/challenge')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'wallet-close' })
  async closeChallenge(@Param('token') token: string, @Headers('host') host: string | undefined): Promise<unknown> {
    return this.ownerChallenge(token, 'close', host);
  }

  /** «Me voy»: con Face ID, solo desbloqueando el móvil del saldo. */
  @Public()
  @Post(':token/close')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'wallet-close' })
  async close(
    @Param('token') token: string,
    @Body() body: { response?: unknown } | undefined,
    @Headers('host') host: string | undefined,
  ): Promise<ClientWalletState> {
    const wallet = await this.charges.walletRefByToken(token);
    await this.passkeys.assertOwner(wallet.id, `close:${wallet.id}`, host, body?.response);
    return this.charges.requestClose(token);
  }

  /** Reto atado a esta acción y a este saldo; 409 si el saldo no tiene Face ID (no hace falta). */
  private async ownerChallenge(token: string, action: 'pin' | 'close', host: string | undefined): Promise<unknown> {
    const wallet = await this.charges.walletRefByToken(token);
    if (!(await this.passkeys.hasPasskey(wallet.id))) {
      throw new ConflictException({ message: 'Este saldo no tiene Face ID', code: 'FACE_ID_NOT_SET' });
    }
    return this.passkeys.challenge(`${action}:${wallet.id}`, host);
  }
}
