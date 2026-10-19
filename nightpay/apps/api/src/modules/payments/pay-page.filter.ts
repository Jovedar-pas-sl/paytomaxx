import { Catch, HttpException, HttpStatus, type ArgumentsHost } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ProblemDetailsFilter } from '../../common/filters/problem-details.filter';
import { resolveLanguage } from './pay-i18n';
import { renderBusyPage } from './public-pay.pages';

/** Lo que espera la página antes de volver a cargarse sola (entre estos dos). */
const MIN_RETRY_S = 5;
const MAX_RETRY_S = 30;

/**
 * GET de las páginas de /pay (pago, «Comprobando», formulario, justificante):
 * el 429 de su @IpRateLimit es una página en HTML, en su idioma, que espera y
 * se vuelve a cargar sola (antes, un JSON en mitad del pago y sin refresco).
 * Lo demás, como siempre (RFC 7807).
 */
@Catch()
export class PayPageFilter extends ProblemDetailsFilter {
  constructor() {
    super(process.env.NODE_ENV === 'production');
  }

  override catch(exception: unknown, host: ArgumentsHost): void {
    if (!(exception instanceof HttpException) || exception.getStatus() !== HttpStatus.TOO_MANY_REQUESTS) {
      super.catch(exception, host);
      return;
    }
    const req = host.switchToHttp().getRequest<FastifyRequest>();
    const res = host.switchToHttp().getResponse<FastifyReply>();
    const accept = req.headers['accept-language'];
    const lang = resolveLanguage((req.query as { lang?: unknown } | undefined)?.lang, Array.isArray(accept) ? accept[0] : accept);
    const wait = retryAfterOf(exception);
    // Solo nuestras páginas: se vuelve a la misma (ruta relativa, sin dominio).
    const again = typeof req.url === 'string' && req.url.startsWith('/pay/') ? req.url : '/';
    res
      .status(HttpStatus.TOO_MANY_REQUESTS)
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header('Retry-After', String(wait))
      .send(renderBusyPage(lang, again, wait));
  }
}

function retryAfterOf(exception: HttpException): number {
  const body = exception.getResponse() as { retryAfter?: unknown } | string;
  const raw = typeof body === 'object' && typeof body.retryAfter === 'number' ? body.retryAfter : MIN_RETRY_S;
  return Math.min(MAX_RETRY_S, Math.max(MIN_RETRY_S, Math.round(raw)));
}
