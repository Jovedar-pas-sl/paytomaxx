import { Controller, Get, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public } from '../../common/decorators/public.decorator';
import { MANROPE_WOFF2 } from './brand-font';

/** La URL lleva la versión (?v=): un año en caché sin miedo a quedarse con una vieja. */
const FONT_CACHE = 'public, max-age=31536000, immutable';

/**
 * GET /pay/assets/manrope.woff2 — la letra de la marca para las páginas del
 * cliente (/pay, /s, /w), desde nuestro dominio: la CSP (font-src 'self' por
 * default-src) no deja cargarla de fuera, y así tampoco se pregunta a Google
 * nada sobre el cliente. Fuera de /v1, como /pay (unprefixed-routes.ts).
 */
@Controller('pay')
export class BrandFontController {
  @Public()
  @Get('assets/manrope.woff2')
  manrope(@Res() res: FastifyReply): void {
    res
      .status(200)
      .header('Content-Type', 'font/woff2')
      .header('Cache-Control', FONT_CACHE)
      .header('X-Content-Type-Options', 'nosniff')
      .send(MANROPE_WOFF2);
  }
}
