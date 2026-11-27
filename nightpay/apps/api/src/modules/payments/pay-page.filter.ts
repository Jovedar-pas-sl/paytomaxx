import { Catch, HttpException, HttpStatus, Logger, type ArgumentsHost } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { isDatabaseBusy, ProblemDetailsFilter } from '../../common/filters/problem-details.filter';
import { redactSecretsInUrl } from '../../common/logging/redact-url';
import { resolveLanguage } from './customer-lang';
import { renderBusyPage } from './public-pay.pages';

/** Lo que espera la página antes de volver a cargarse sola (entre estos dos). */
export const MIN_RETRY_S = 5;
const MAX_RETRY_S = 30;

/**
 * GET de las páginas de /pay (pago, «Comprobando», formulario, justificante)
 * y el POST del justificante por correo:
 * el 429 de su @IpRateLimit y la base sin conexión libre (P2028/P2024, 503:
 * mucha gente pagando a la vez) son una página en HTML, en su idioma, que
 * espera y se vuelve a cargar sola (antes, un JSON en mitad del pago y sin
 * refresco). Lo demás, como siempre (RFC 7807).
 */
@Catch()
export class PayPageFilter extends ProblemDetailsFilter {
  private readonly pageLogger = new Logger(PayPageFilter.name);

  constructor() {
    super(process.env.NODE_ENV === 'production');
  }

  override catch(exception: unknown, host: ArgumentsHost): void {
    const limited = exception instanceof HttpException && exception.getStatus() === HttpStatus.TOO_MANY_REQUESTS;
    if (!limited && !isDatabaseBusy(exception)) {
      super.catch(exception, host);
      return;
    }
    const req = host.switchToHttp().getRequest<FastifyRequest>();
    const res = host.switchToHttp().getResponse<FastifyReply>();
    const lang = resolveLanguage((req.query as { lang?: unknown } | undefined)?.lang, req.headers.cookie);
    const wait = limited ? retryAfterOf(exception) : MIN_RETRY_S;
    // Solo nuestras páginas: se vuelve a la misma (ruta relativa, sin dominio).
    // Un POST (el justificante por correo) no se repite: a la página de la que
    // salió, que es su ruta sin el último tramo (/pay/:token/receipt/email → /pay/:token/receipt).
    const url = typeof req.url === 'string' && req.url.startsWith('/pay/') ? req.url : '/';
    const again = req.method === 'POST' ? pageOfPost(url) : url;
    if (!limited) this.pageLogger.warn(`Base de datos sin conexión libre a tiempo: «Hay mucha gente pagando» en ${redactSecretsInUrl(String(req.url))}`);
    res
      .status(limited ? HttpStatus.TOO_MANY_REQUESTS : HttpStatus.SERVICE_UNAVAILABLE)
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header('Retry-After', String(wait))
      .send(renderBusyPage(lang, again, wait));
  }
}

function pageOfPost(url: string): string {
  const q = url.indexOf('?');
  const path = q === -1 ? url : url.slice(0, q);
  const cut = path.replace(/\/+$/, '').lastIndexOf('/');
  const page = cut > 0 ? path.slice(0, cut) : '/';
  return page.startsWith('/pay/') ? `${page}${q === -1 ? '' : url.slice(q)}` : '/';
}

function retryAfterOf(exception: HttpException): number {
  const body = exception.getResponse() as { retryAfter?: unknown } | string;
  const raw = typeof body === 'object' && typeof body.retryAfter === 'number' ? body.retryAfter : MIN_RETRY_S;
  return Math.min(MAX_RETRY_S, Math.max(MIN_RETRY_S, Math.round(raw)));
}
