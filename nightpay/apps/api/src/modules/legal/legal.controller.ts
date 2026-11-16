import { Controller, Get, Headers, NotFoundException, Param, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public } from '../../common/decorators/public.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { customerLanguage } from '../payments/customer-lang';
import { isLegalDocId } from './legal-docs';
import { renderLegalPage } from './legal-page';

/**
 * Los textos legales (fuera de /v1, como las páginas del cliente):
 *   GET /legal/aviso-legal · /legal/privacidad · /legal/cookies · /legal/condiciones
 * Idioma: ?lang=, si no la cookie del cliente, si no castellano.
 */
@Controller('legal')
export class LegalController {
  @Public()
  @Get(':doc')
  @IpRateLimit({ max: 120, windowSec: 60, scope: 'legal-page', failOpen: true })
  page(
    @Param('doc') doc: string,
    @Query('lang') langQuery: string | undefined,
    @Headers('cookie') cookies: string | undefined,
    @Res() res: FastifyReply,
  ): void {
    if (!isLegalDocId(doc)) throw new NotFoundException();
    const { lang, setCookie } = customerLanguage(langQuery, cookies);
    if (setCookie) res.header('Set-Cookie', setCookie);
    res
      .status(200)
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-cache')
      .send(renderLegalPage(doc, lang));
  }
}
