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
import type { FastifyReply } from 'fastify';
import { Public } from '../../common/decorators/public.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { resolveLanguage } from '../payments/pay-i18n';
import { renderQrChargePage } from './qr-charge-page';
import { WalletChargesService } from './wallet-charges.service';
import { WalletPasskeysService } from './wallet-passkeys.service';

/**
 * Pagar con el saldo escaneando el QR de la chica (fuera de /v1):
 *  - GET  /s/:token            → "Te cobran 60 € · Masaje" y el botón de pagar.
 *  - POST /s/:token/challenge  → reto para la llave del cliente (Face ID…).
 *  - POST /s/:token/pay        → su móvil lo firmó: se cobra de SU saldo.
 * El token del QR solo dice qué cobro es; el saldo lo dice la llave del
 * cliente, que solo puede usar él desbloqueando su móvil.
 */
@Controller('s')
export class PublicSaldoController {
  private readonly charges: WalletChargesService;
  private readonly passkeys: WalletPasskeysService;

  constructor(
    @Inject(WalletChargesService) charges: WalletChargesService,
    @Inject(WalletPasskeysService) passkeys: WalletPasskeysService,
  ) {
    this.charges = charges;
    this.passkeys = passkeys;
  }

  @Public()
  @Get(':token')
  @IpRateLimit({ max: 120, windowSec: 60, scope: 'saldo-qr-page' })
  async page(
    @Param('token') token: string,
    @Query('lang') langQuery: string | undefined,
    @Headers('accept-language') acceptLanguage: string | undefined,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const view = await this.charges.qrChargeForClient(token);
    res
      .status(200)
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(renderQrChargePage(token, resolveLanguage(langQuery, acceptLanguage), view));
  }

  @Public()
  @Post(':token/challenge')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'saldo-qr-pay' })
  async challenge(@Param('token') token: string, @Headers('host') host: string | undefined): Promise<unknown> {
    const view = await this.charges.qrChargeForClient(token);
    if (view.status !== 'PENDING') throw new ConflictException('Este cobro ya no está pendiente');
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
  ): Promise<{ amountCents: number; balanceCents: number }> {
    const walletId = await this.passkeys.verify(scopeOf(token), host, body?.response);
    return this.charges.payQrCharge(token, walletId);
  }
}

/** El reto vale solo para este cobro. */
function scopeOf(token: string): string {
  return `charge:${token}`;
}
