import { Body, Controller, Get, Header, Headers, HttpCode, Inject, NotFoundException, Param, Post, Query, Res, UnauthorizedException } from '@nestjs/common';
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
 *  - POST /w/:token/aviso                 → apunta este navegador al saldo (con el mismo acceso que ver el saldo).
 *  - POST /w/:token/aviso/off             → lo quita.
 *  - GET  /w/no/:token                    → «No he sido yo»: enseña el cobro y pide confirmar (no cambia nada).
 *  - POST /w/no/:token                    → confirmado: bloquea su ficha y su PIN y avisa al local.
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
  @Post(':token/aviso')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'wallet-aviso' })
  async subscribe(
    @Param('token') token: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: FastifyReply,
    @Headers('cookie') cookies?: string,
  ): Promise<{ ok: true }> {
    const walletId = await this.allowedWallet(token, cookies, res);
    return this.alerts.subscribe(walletId, body, resolveLanguage(undefined, cookies));
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
