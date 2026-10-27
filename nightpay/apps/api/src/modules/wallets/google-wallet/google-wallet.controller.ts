import { Controller, Get, Header, HttpCode, Inject, NotFoundException, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public } from '../../../common/decorators/public.decorator';
import { IpRateLimit } from '../../../common/guards/ip-rate-limit.guard';
import { GOOGLE_WALLET_BUTTONS } from './google-wallet-button';
import { isPayLanguage } from '../../payments/customer-lang';
import { GoogleWalletService } from './google-wallet.service';
import { WalletViewGuard } from '../wallet-view.guard';

/** El botón oficial cambia poco: un día en caché. */
const BUTTON_CACHE = 'public, max-age=86400';

/**
 * Google Wallet en la página del saldo (fuera de /v1, como el resto de /w):
 *  - POST /w/:token/google-wallet          → enlace para guardar el pase.
 *  - GET  /w/assets/google-wallet/:lang    → el botón oficial (SVG) desde nuestro dominio.
 * Sin Google Wallet configurado, las dos dan 404.
 */
@Controller('w')
export class GoogleWalletController {
  private readonly gwallet: GoogleWalletService;

  constructor(@Inject(GoogleWalletService) gwallet: GoogleWalletService) {
    this.gwallet = gwallet;
  }

  /**
   * «Añadir a Google Wallet»: como las demás acciones de /w, el enlace del
   * saldo es la credencial (sin él no hay pase) y el límite por IP, el mismo
   * que el de las demás acciones de /w, es contra abusos (cada toque llama a
   * Google; en un local muchos clientes comparten el wifi).
   */
  @Public()
  @Post(':token/google-wallet')
  @UseGuards(WalletViewGuard)
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'wallet-gwallet' })
  async save(@Param('token') token: string): Promise<{ saveUrl: string }> {
    return this.gwallet.saveLink(token);
  }

  @Public()
  @Get('assets/google-wallet/:lang')
  button(@Param('lang') lang: string, @Res() res: FastifyReply): void {
    if (!this.gwallet.enabled || !isPayLanguage(lang)) throw new NotFoundException();
    res
      .status(200)
      .header('Content-Type', 'image/svg+xml; charset=utf-8')
      .header('Cache-Control', BUTTON_CACHE)
      .header('Content-Security-Policy', "default-src 'none'")
      .header('X-Content-Type-Options', 'nosniff')
      .send(GOOGLE_WALLET_BUTTONS[lang].svg);
  }
}
