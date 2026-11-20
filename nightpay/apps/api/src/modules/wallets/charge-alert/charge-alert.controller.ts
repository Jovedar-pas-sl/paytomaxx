import { Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Query, Res, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply } from 'fastify';
import { Public } from '../../../common/decorators/public.decorator';
import { IpRateLimit } from '../../../common/guards/ip-rate-limit.guard';
import { customerLanguage, resolveLanguage } from '../../payments/customer-lang';
import { WalletChargesService } from '../wallet-charges.service';
import { WalletPasskeysService } from '../wallet-passkeys.service';
import { walletViewAccess } from '../wallet-view-access';
import { ChargeAlertService } from './charge-alert.service';
import { SERVICE_WORKER_JS, renderNotMePage, walletManifest } from './charge-alert-view';
import { ChargeDisputeService } from './charge-dispute.service';

export const AVISO_NEEDS_KEY_MESSAGE = 'Para activar el aviso, primero activa Face ID o huella en este saldo: pide en recepción el QR de activación.';

/** El reto de la llave, atado a apuntarse a los avisos y a este saldo. */
function avisoScope(walletId: string): string {
  return `aviso:${walletId}`;
}

/** Forma del enlace del saldo (antes de devolver un manifiesto con él). */
const WALLET_TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

function sendHtml(res: FastifyReply, html: string): void {
  res
    .status(200)
    .header('Content-Type', 'text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .header('Referrer-Policy', 'no-referrer')
    .send(html);
}

/**
 * «Aviso en cada cobro» (páginas del cliente, fuera de /v1):
 *  - GET  /w/aviso-sw.js                  → el service worker (enseña el aviso con la página cerrada).
 *  - GET  /w/:token/manifest.webmanifest  → para añadir el saldo a la pantalla de inicio (iPhone: así llegan los avisos).
 *  - POST /w/:token/aviso/challenge       → reto para su Face ID o huella (409 FACE_ID_NOT_SET si el saldo no tiene).
 *  - POST /w/:token/aviso                 → apunta este navegador al saldo: con el acceso de ver el saldo Y su
 *                                           Face ID o huella (con solo el enlace privado, no).
 *  - POST /w/:token/aviso/estado          → ¿este navegador está apuntado a este saldo? (la fila de la página).
 *  - POST /w/:token/aviso/off             → lo quita.
 *  - GET  /w/no/:token                    → «No he sido yo»: enseña el cobro y pide confirmar (no cambia nada).
 *  - POST /w/no/:token                    → confirmado: bloquea su ficha y su PIN y avisa al local.
 *  - POST /w/:token/no/:chargeId/challenge, /w/:token/no/:chargeId
 *                                         → «No he sido yo» desde un movimiento del saldo: con su
 *                                           acceso y su Face ID (si lo tiene), el enlace de /w/no.
 * El :token de /w/no es el enlace firmado del cobro (not-me-token.ts), no el del saldo.
 */
@Controller('w')
export class PublicChargeAlertController {
  constructor(
    @Inject(WalletChargesService) private readonly charges: WalletChargesService,
    @Inject(WalletPasskeysService) private readonly passkeys: WalletPasskeysService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(ChargeAlertService) private readonly alerts: ChargeAlertService,
    @Inject(ChargeDisputeService) private readonly disputes: ChargeDisputeService,
  ) {}

  @Public()
  @Get('aviso-sw.js')
  @IpRateLimit({ max: 120, windowSec: 60, scope: 'wallet-aviso-sw', failOpen: true })
  serviceWorker(@Res() res: FastifyReply): void {
    res
      .status(200)
      .header('Content-Type', 'application/javascript; charset=utf-8')
      // El navegador lo vuelve a pedir para ver si cambió.
      .header('Cache-Control', 'no-cache')
      .send(SERVICE_WORKER_JS);
  }

  @Public()
  @Get(':token/manifest.webmanifest')
  @IpRateLimit({ max: 120, windowSec: 60, scope: 'wallet-manifest', failOpen: true })
  manifest(
    @Param('token') token: string,
    @Res() res: FastifyReply,
    @Query('lang') langQuery?: string,
    @Headers('cookie') cookies?: string,
  ): void {
    if (!WALLET_TOKEN_RE.test(token)) throw new NotFoundException('Saldo no encontrado');
    res
      .status(200)
      .header('Content-Type', 'application/manifest+json; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(walletManifest(`/w/${token}`, resolveLanguage(langQuery, cookies)));
  }

  @Public()
  @Post(':token/aviso/challenge')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'wallet-aviso' })
  async challenge(@Param('token') token: string, @Headers('host') host: string | undefined): Promise<unknown> {
    const wallet = await this.charges.walletRefByToken(token);
    await this.requireKey(wallet.id);
    return this.passkeys.challenge(avisoScope(wallet.id), host);
  }

  /** Apuntarse: con su Face ID o huella (la llave del saldo), nunca con el enlace solo. */
  @Public()
  @Post(':token/aviso')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'wallet-aviso' })
  async subscribe(
    @Param('token') token: string,
    @Body() body: { subscription?: unknown; response?: unknown } | undefined,
    @Res({ passthrough: true }) res: FastifyReply,
    @Headers('host') host: string | undefined,
    @Headers('cookie') cookies?: string,
  ): Promise<{ ok: true }> {
    const walletId = await this.allowedWallet(token, cookies, res);
    await this.requireKey(walletId);
    const owner = await this.passkeys.verify(avisoScope(walletId), host, body?.response);
    if (owner !== walletId) throw new ForbiddenException({ message: 'Confirma con el Face ID de este saldo.', code: 'FACE_ID_WRONG' });
    return this.alerts.subscribe(walletId, body?.subscription, resolveLanguage(undefined, cookies));
  }

  @Public()
  @Post(':token/aviso/estado')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'wallet-aviso-estado', failOpen: true })
  async status(
    @Param('token') token: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: FastifyReply,
    @Headers('cookie') cookies?: string,
  ): Promise<{ on: boolean }> {
    const walletId = await this.allowedWallet(token, cookies, res);
    return { on: await this.alerts.isSubscribed(walletId, body) };
  }

  @Public()
  @Post(':token/aviso/off')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'wallet-aviso' })
  async unsubscribe(
    @Param('token') token: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: FastifyReply,
    @Headers('cookie') cookies?: string,
  ): Promise<{ ok: true }> {
    const walletId = await this.allowedWallet(token, cookies, res);
    return this.alerts.unsubscribe(walletId, body);
  }

  @Public()
  @Get('no/:token')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'wallet-not-me' })
  async notMePage(
    @Param('token') token: string,
    @Res() res: FastifyReply,
    @Query('lang') langQuery?: string,
    @Headers('cookie') cookies?: string,
  ): Promise<void> {
    const { lang, setCookie } = customerLanguage(langQuery, cookies);
    if (setCookie) res.header('Set-Cookie', setCookie);
    sendHtml(res, renderNotMePage(`/w/no/${encodeURIComponent(token)}`, lang, await this.disputes.view(token)));
  }

  /** El formulario de la página (text/plain y sin cuerpo: funciona sin JS). */
  @Public()
  @Post('no/:token')
  @IpRateLimit({ max: 10, windowSec: 60, scope: 'wallet-not-me-confirm' })
  async notMeConfirm(
    @Param('token') token: string,
    @Res() res: FastifyReply,
    @Query('lang') langQuery?: string,
    @Headers('cookie') cookies?: string,
  ): Promise<void> {
    const lang = resolveLanguage(langQuery, cookies);
    sendHtml(res, renderNotMePage(`/w/no/${encodeURIComponent(token)}`, lang, await this.disputes.dispute(token)));
  }

  /** «No he sido yo» desde un movimiento del saldo, paso 1: reto para su Face ID (409 si el saldo no tiene). */
  @Public()
  @Post(':token/no/:chargeId/challenge')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'wallet-not-me-link' })
  async notMeChallenge(
    @Param('token') token: string,
    @Param('chargeId', ParseUUIDPipe) _chargeId: string,
    @Headers('host') host: string | undefined,
  ): Promise<unknown> {
    const wallet = await this.charges.walletRefByToken(token);
    if (!(await this.passkeys.hasPasskey(wallet.id))) throw new ConflictException({ message: 'Este saldo no tiene Face ID', code: 'FACE_ID_NOT_SET' });
    return this.passkeys.challenge(`no:${wallet.id}`, host);
  }

  /**
   * Paso 2: con el acceso de ver el saldo y, si lo tiene, su Face ID, el
   * enlace firmado de ESE cobro: la misma página que el aviso (/w/no/…), que
   * pide confirmar y bloquea su ficha y su PIN.
   */
  @Public()
  @Post(':token/no/:chargeId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'wallet-not-me-link' })
  async notMeLink(
    @Param('token') token: string,
    @Param('chargeId', ParseUUIDPipe) chargeId: string,
    @Body() body: { response?: unknown } | undefined,
    @Res({ passthrough: true }) res: FastifyReply,
    @Headers('host') host: string | undefined,
    @Headers('cookie') cookies?: string,
  ): Promise<{ url: string }> {
    const walletId = await this.allowedWallet(token, cookies, res);
    await this.passkeys.assertOwner(walletId, `no:${walletId}`, host, body?.response);
    return { url: await this.disputes.linkFor(walletId, chargeId) };
  }

  /** Sin Face ID ni huella no se apunta: primero, activarlo (recepción o el QR de activación). */
  private async requireKey(walletId: string): Promise<void> {
    if (!(await this.passkeys.hasPasskey(walletId))) {
      throw new ConflictException({ message: AVISO_NEEDS_KEY_MESSAGE, code: 'FACE_ID_NOT_SET' });
    }
  }

  /** El saldo, con el mismo acceso que ver su estado (/w/:token/state). */
  private async allowedWallet(token: string, cookies: string | undefined, res: FastifyReply): Promise<string> {
    const access = await walletViewAccess(
      {
        walletRefByToken: (value) => this.charges.walletRefByToken(value),
        hasPasskey: (id) => this.passkeys.hasPasskey(id),
        secret: this.config.get<string>('COOKIE_SECRET') ?? '',
      },
      token,
      cookies,
    );
    if (!access.allowed) throw new UnauthorizedException({ message: 'Desbloquea tu saldo con tu teléfono.', code: 'WALLET_VIEW_REQUIRED' });
    if (access.renew) res.header('Set-Cookie', access.renew);
    return (await this.charges.walletRefByToken(token)).id;
  }
}
