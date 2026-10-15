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
