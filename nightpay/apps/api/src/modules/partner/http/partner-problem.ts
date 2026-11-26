import { HttpException, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ClsServiceManager } from 'nestjs-cls';
import { PARTNER_ERRORS, partnerProblemType, type PartnerErrorCode, type PartnerProblem } from '@nightpay/contracts';
import { sanitizeTraceId } from '../../../common/context/trace-id';
import type { RequestContext } from '../../../common/context/request-context';
import { isDatabaseBusy, loggableError } from '../../../common/filters/problem-details.filter';
import { ZodValidationException } from '../../../common/pipes/zod.pipe';
import { isPartnerPath } from '../../../common/http/partner-path';
import { redactLogText } from '../../../common/logging/redact-url';
import { reportError } from '../../../common/observability/sentry';

export { isPartnerPath };

/**
 * Los errores de la API de socios: `application/problem+json` del contrato
 * (Problem), con `code` del catálogo (contracts/partner/errors.ts), `detail`
 * en inglés o español (Accept-Language), `Request-Id`, `Cache-Control:
 * no-store` y `Retry-After` en 429 y 503. Nunca el `_filterVersion` ni los
 * textos internos en español del resto del API.
 */

export type PartnerProblemExtra = Partial<
  Pick<PartnerProblem, 'param' | 'required_scope' | 'limit' | 'remaining' | 'method' | 'reason' | 'available' | 'operation'>
>;

/** Un `detail` propio: el mismo texto en los dos idiomas, o uno por idioma (Accept-Language). */
export type PartnerDetail = string | { readonly en: string; readonly es: string };

export class PartnerHttpException extends HttpException {
  constructor(
    readonly code: PartnerErrorCode,
    readonly extra: PartnerProblemExtra = {},
    readonly retryAfter?: number,
    readonly detail?: PartnerDetail,
  ) {
    super({ code, ...extra }, PARTNER_ERRORS[code].status);
  }
}

/** Un error del catálogo (partner-problem.spec.ts comprueba que el código está en él). */
export function partnerError(
  code: PartnerErrorCode,
  extra: PartnerProblemExtra = {},
  retryAfter?: number,
  detail?: PartnerDetail,
): PartnerHttpException {
  return new PartnerHttpException(code, extra, retryAfter, detail);
}

export interface PartnerFault {
  code: PartnerErrorCode;
  extra: PartnerProblemExtra;
  detail?: PartnerDetail;
  retryAfter?: number;
}

const DEFAULT_RETRY_AFTER: Readonly<Record<number, number>> = { 429: 60, 503: 5 };
const logger = new Logger('PartnerProblem');

function statusOf(e: unknown): number | undefined {
  if (e instanceof HttpException) return e.getStatus();
  const status = (e as { statusCode?: unknown } | null)?.statusCode;
  return e instanceof Error && typeof status === 'number' ? status : undefined;
}

/**
 * El 400 del ZodValidationPipe, por su primer fallo crudo de Zod (el pipe los
 * añade a la excepción: flatten() pierde el tipo y el orden):
 *  - los topes de input-limits (sin fallos) o el cuerpo que no es un objeto JSON
 *    (`invalid_type` en la raíz): 400 invalid_request;
 *  - un campo de más (`unrecognized_keys`): 422 validation_failed con la
 *    primera clave desconocida;
 *  - cualquier otro: 422 validation_failed con el primer segmento de su ruta.
 */
function validationFault(e: HttpException): PartnerFault | null {
  const body = e.getResponse();
  if (!body || typeof body !== 'object' || (body as { title?: unknown }).title !== 'Validation failed') return null;
  const first = e instanceof ZodValidationException ? e.zodIssues[0] : undefined;
  if (!first || (first.code === 'invalid_type' && first.path.length === 0)) return { code: 'invalid_request', extra: {} };
  if (first.code === 'unrecognized_keys') {
    const key = first.keys[0] ?? '';
    return { code: 'validation_failed', extra: { param: key }, detail: `${key}: Unrecognized key` };
  }
  if (first.path.length === 0) return { code: 'validation_failed', extra: {}, detail: first.message };
  const param = String(first.path[0]);
  return { code: 'validation_failed', extra: { param }, detail: `${param}: ${first.message}` };
}

/** Cada fallo a su código: nunca sale un texto interno ni un 4xx sin código. */
export function toPartnerError(e: unknown): PartnerFault {
  if (e instanceof PartnerHttpException) return { code: e.code, extra: e.extra, detail: e.detail, retryAfter: e.retryAfter };
  const status = statusOf(e);
  if (status === 404) return { code: 'not_found', extra: {} };
  if (status === 413) return { code: 'body_too_large', extra: {} };
  if (status === 429) return { code: 'rate_limited', extra: {} };
  if (status === 400 && e instanceof HttpException) {
    const fault = validationFault(e);
    if (fault) return fault;
  }
  if (status !== undefined && status >= 400 && status < 500) return { code: 'invalid_request', extra: {} };
  if (isDatabaseBusy(e)) return { code: 'try_later', extra: {}, retryAfter: 5 };
  return { code: 'internal_error', extra: {} };
}

interface ProblemRequest {
  url: string;
  headers: Record<string, string | string[] | undefined>;
}
interface ProblemReply {
  header(key: string, value: string | number): unknown;
  getHeader?(key: string): unknown;
  status(code: number): ProblemReply;
  type(contentType: string): ProblemReply;
  send(payload: unknown): unknown;
}

/** `es` si el primer idioma pedido es español; si no, inglés. */
export function partnerLanguage(req: Pick<ProblemRequest, 'headers'>): 'en' | 'es' {
  const raw = req.headers['accept-language'];
  const first = (Array.isArray(raw) ? raw[0] : raw)?.split(',')[0]?.split(';')[0]?.trim().toLowerCase() ?? '';
  return first === 'es' || first.startsWith('es-') ? 'es' : 'en';
}

/** El de la petición (contexto CLS: el X-Request-Id válido o uno nuevo); sin contexto, lo mismo a mano. */
export function partnerRequestId(req: Pick<ProblemRequest, 'headers'>): string {
  const cls = ClsServiceManager.getClsService<{ ctx?: RequestContext }>();
  const fromCls = cls?.isActive() ? cls.get('ctx')?.traceId : undefined;
  return fromCls ?? sanitizeTraceId(req.headers['x-request-id']) ?? randomUUID();
}

export function renderPartnerProblem(exception: unknown, req: ProblemRequest, reply: ProblemReply): void {
  const fault = toPartnerError(exception);
  if (fault.code === 'internal_error') {
    const safe = exception instanceof Error ? loggableError(exception) : new Error(`Non-Error throw: ${String(exception)}`);
    // El mensaje y la traza pueden llevar una clave (la limpieza de Sentry no protege el log).
    logger.error(`API de socios: fallo inesperado (${safe.name}): ${redactLogText(safe.message)}`, safe.stack === undefined ? undefined : redactLogText(safe.stack));
    reportError(safe, { tag: 'partner.unhandled' });
  }
  const def = PARTNER_ERRORS[fault.code];
  const lang = partnerLanguage(req);
  const detail = typeof fault.detail === 'string' ? fault.detail : (fault.detail?.[lang] ?? def[lang]);
  const requestId = partnerRequestId(req);
  reply.header('Request-Id', requestId);
  reply.header('Cache-Control', 'no-store');
  if (DEFAULT_RETRY_AFTER[def.status]) {
    const existing = Number(reply.getHeader?.('retry-after'));
    reply.header('Retry-After', fault.retryAfter ?? (existing > 0 ? existing : DEFAULT_RETRY_AFTER[def.status]!));
  }
  reply
    .status(def.status)
    .type('application/problem+json')
    .send({
      type: partnerProblemType(fault.code),
      title: def.title,
      status: def.status,
      code: fault.code,
      detail,
      ...fault.extra,
      request_id: requestId,
    });
}
