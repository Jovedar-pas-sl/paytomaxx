import { isPartnerPath } from '../http/partner-path';

/**
 * X-Trace-Id que manda el cliente: se guarda en audit_events y se devuelve en
 * los errores, así que solo se acepta si es corto y sin caracteres raros
 * (letras, números y guiones, hasta 64). Si no, se genera uno nuevo.
 */
const TRACE_ID = /^[A-Za-z0-9-]{1,64}$/;

export function sanitizeTraceId(value: unknown): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && TRACE_ID.test(first) ? first : undefined;
}

/**
 * El id de la petición: en la API de socios, su X-Request-Id (el contrato lo
 * devuelve en Request-Id); en el resto, X-Trace-Id como siempre. Si no vale, `fallback`.
 */
export function requestTraceId(
  req: { url?: string; originalUrl?: string; headers?: Record<string, unknown> } | undefined,
  fallback: string,
): string {
  // En el middleware (middie) `url` va sin el prefijo donde se montó: la entera es `originalUrl`.
  const header = isPartnerPath(req?.originalUrl ?? req?.url) ? 'x-request-id' : 'x-trace-id';
  return sanitizeTraceId(req?.headers?.[header]) ?? fallback;
}
