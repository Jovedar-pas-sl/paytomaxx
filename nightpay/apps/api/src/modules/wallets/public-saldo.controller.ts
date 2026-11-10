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
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply } from 'fastify';
import { Public } from '../../common/decorators/public.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { customerLanguage } from '../payments/customer-lang';
import { renderQrChargePage } from './qr-charge-page';
import { WalletChargesService, type QrChargeClientView, type QrChargePaid } from './wallet-charges.service';
import { WalletPasskeysService } from './wallet-passkeys.service';
import { walletViewSetCookies } from './wallet-view-session';

/**
 * Pagar con el saldo escaneando el QR de la chica (fuera de /v1):
 *  - GET  /s/:token            → "Te cobran 60 € · Masaje" y el botón de pagar.
 *  - POST /s/:token/challenge  → reto para la llave del cliente (Face ID…).
 *  - POST /s/:token/pay        → su móvil lo firmó: se cobra de SU saldo.
 *  - GET  /s/:token/state      → ¿sigue pendiente? (tras un fallo que no se sabe si cobró).
 * El token del QR solo dice qué cobro es; el saldo lo dice la llave del
 * cliente, que solo puede usar él desbloqueando su móvil.
 */
@Controller('s')
export class PublicSaldoController {
  private readonly charges: WalletChargesService;
  private readonly passkeys: WalletPasskeysService;
  private readonly config: ConfigService;

  constructor(
    @Inject(WalletChargesService) charges: WalletChargesService,
    @Inject(WalletPasskeysService) passkeys: WalletPasskeysService,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.charges = charges;
    this.passkeys = passkeys;
    this.config = config;
  }

  @Public()
  @Get(':token')
  @IpRateLimit({ max: 120, windowSec: 60, scope: 'saldo-qr-page', failOpen: true })
  async page(
    @Param('token') token: string,
    @Query('lang') langQuery: string | undefined,
    @Headers('cookie') cookies: string | undefined,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const view = await this.charges.qrChargeForClient(token);
    // Español por defecto; el idioma que elige el cliente queda en su cookie.
    const { lang, setCookie } = customerLanguage(langQuery, cookies);
    if (setCookie) res.header('Set-Cookie', setCookie);
    res
      .status(200)
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(renderQrChargePage(token, lang, view));
  }

  /**
   * Tras un fallo del pago que no dice si se cobró (sin respuesta, 408, 429,
   * 5xx), la página pregunta aquí antes de dejar pagar otra vez: si sigue
   * pendiente, se puede; si se cobró, enseña su PAGADO con el código (el mismo
   * que ya sale en la página de un cobro pagado); si no, recarga y enseña lo
   * que pasó. Antes de pagarse, solo el estado (el código no sale).
   */
  @Public()
  @Get(':token/state')
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'saldo-qr-state', failOpen: true })
  async state(@Param('token') token: string): Promise<{ status: QrChargeClientView['status']; code?: string }> {
    const view = await this.charges.qrChargeForClient(token);
    return view.status === 'ACCEPTED' && view.code ? { status: view.status, code: view.code } : { status: view.status };
  }

  @Public()
  @Post(':token/challenge')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'saldo-qr-pay' })
  async challenge(@Param('token') token: string, @Headers('host') host: string | undefined): Promise<unknown> {
    const view = await this.charges.qrChargeForClient(token);
    if (view.status !== 'PENDING') {
      throw new ConflictException({ message: 'Este cobro ya no está pendiente', code: 'CHARGE_NOT_PENDING' });
    }
    return this.passkeys.challenge(scopeOf(token), host);
  }

  @Public()
  @Post(':token/pay')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'saldo-qr-pay' })
  async pay(
    @Param('token') token: string,
    @Body() body: { response?: unknown } | undefined,
    @Headers('host') host: string | undefined,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<QrChargePaid & { walletUrl?: string }> {
    const walletId = await this.passkeys.verify(scopeOf(token), host, body?.response);
    const paid = await this.charges.payQrCharge(token, walletId);
    // «Ver mi saldo» en su «Pagado»: acaba de desbloquear su móvil con la
    // llave de ese saldo, así que se abre la sesión de consulta (como al
    // entrar por la ficha) y la página lleva el enlace.
    const wallet = await this.charges.liveWalletRef(walletId).catch(() => null);
    if (!wallet) return paid;
    res.header('Set-Cookie', walletViewSetCookies(this.config.get<string>('COOKIE_SECRET') ?? '', wallet));
    return { ...paid, walletUrl: `/w/${encodeURIComponent(wallet.qrToken)}` };
  }
}

/** El reto vale solo para este cobro. */
function scopeOf(token: string): string {
  return `charge:${token}`;
}
