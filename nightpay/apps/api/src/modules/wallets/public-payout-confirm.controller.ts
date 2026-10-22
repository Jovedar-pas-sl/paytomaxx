import { Body, Controller, Get, Header, Headers, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public } from '../../common/decorators/public.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { resolveLanguage } from '../payments/pay-i18n';
import { renderPayoutConfirmPage } from './reception-payout-page';
import { ReceptionPayoutService } from './reception-payout.service';

/**
 * La salida de recepción con Face ID, en el móvil del cliente (fuera de /v1):
 *  - GET  /w/salida/:token            → «Recepción te devuelve 35 € en efectivo» y el botón.
 *  - POST /w/salida/:token/challenge  → reto para su llave (atado a esa salida).
 *  - POST /w/salida/:token/confirm    → su móvil lo firmó con la llave de ESE saldo.
 * El token del QR solo dice qué salida es; el saldo lo prueba su llave.
 */
@Controller('w')
export class PublicPayoutConfirmController {
  constructor(@Inject(ReceptionPayoutService) private readonly payouts: ReceptionPayoutService) {}

  @Public()
  @Get('salida/:token')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'payout-confirm-page' })
  async page(
    @Param('token') token: string,
    @Query('lang') langQuery: string | undefined,
    @Headers('accept-language') acceptLanguage: string | undefined,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const view = await this.payouts.confirmView(token);
    res
      .status(view ? 200 : 404)
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .send(renderPayoutConfirmPage(`/w/salida/${encodeURIComponent(token)}`, resolveLanguage(langQuery, acceptLanguage), view));
  }

  @Public()
  @Post('salida/:token/challenge')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'payout-confirm' })
  challenge(@Param('token') token: string, @Headers('host') host: string | undefined): Promise<unknown> {
    return this.payouts.challenge(token, host);
  }

  @Public()
  @Post('salida/:token/confirm')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'payout-confirm' })
  confirm(
    @Param('token') token: string,
    @Body() body: { response?: unknown } | undefined,
    @Headers('host') host: string | undefined,
  ): Promise<{ amountCents: number }> {
    return this.payouts.confirm(token, host, body?.response);
  }
}
