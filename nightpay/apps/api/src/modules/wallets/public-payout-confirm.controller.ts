import { Controller, Get, Header, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public } from '../../common/decorators/public.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { customerLanguage } from '../payments/customer-lang';
import { renderPayoutConfirmPage } from './reception-payout-page';
import { saldoNoSeDevuelve } from './saldo-rule';

/**
 * El QR de la salida de recepción con Face ID (fuera de /v1). La salida ya no
 * devuelve el saldo (saldo-rule.ts), así que un QR de antes:
 *  - GET  /w/salida/:token            → la regla en el idioma del cliente y «Ver mi saldo» (410).
 *  - POST /w/salida/:token/challenge  → 409 SALDO_NO_SE_DEVUELVE.
 *  - POST /w/salida/:token/confirm    → 409 SALDO_NO_SE_DEVUELVE.
 */
@Controller('w')
export class PublicPayoutConfirmController {
  @Public()
  @Get('salida/:token')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'payout-confirm-page', failOpen: true })
  page(
    @Param('token') token: string,
    @Query('lang') langQuery: string | undefined,
    @Headers('cookie') cookies: string | undefined,
    @Res() res: FastifyReply,
  ): void {
    const { lang, setCookie } = customerLanguage(langQuery, cookies);
    if (setCookie) res.header('Set-Cookie', setCookie);
    res
      .status(410)
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .send(renderPayoutConfirmPage(`/w/salida/${encodeURIComponent(token)}`, lang));
  }

  @Public()
  @Post('salida/:token/challenge')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'payout-confirm' })
  challenge(): never {
    throw saldoNoSeDevuelve();
  }

  @Public()
  @Post('salida/:token/confirm')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'payout-confirm' })
  confirm(): never {
    throw saldoNoSeDevuelve();
  }
}
