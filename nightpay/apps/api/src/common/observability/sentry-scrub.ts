import { redactSecretsInText, redactSecretsInUrl } from '../logging/redact-url';

/**
 * Limpieza de lo que se envía a Sentry (eventos de error, trazas y
 * breadcrumbs). Los secretos viajan sobre todo en URLs: el token del bot de
 * Telegram va en la ruta (/bot<token>/sendMessage), las claves de los
 * exploradores en la query (apikey=, api-key=), los tokens del saldo y del QR
 * en rutas públicas (/w/, /s/, /pay/).
 */
type Bag = Record<string, unknown>;

const REDACTED = '[REDACTED]';
/** Cabeceras que nunca salen (en minúsculas). */
const SECRET_HEADERS = new Set(['authorization', 'cookie', 'x-origin-auth', 'set-cookie']);
/** Campos del cuerpo de la petición que nunca salen. */
const SECRET_BODY_KEYS = [
  'password',
  'passportLast4',
  'payoutAddress',
  'token',
  'refreshToken',
  'externalTxId',
  'pin',
  'pin2',
  'secret',
  'tokenizationData',
  'Ds_MerchantParameters',
  'Ds_Signature',
];
/** Campos de datos (breadcrumbs, spans) con URL o query. */
const URL_KEYS = ['url', 'http.url', 'url.full', 'http.target', 'url.path', 'server.address.url'];
const QUERY_KEYS = ['http.query', 'url.query', 'query', 'http.fragment', 'url.fragment'];

function isBag(value: unknown): value is Bag {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scrubData(data: unknown): unknown {
  if (!isBag(data)) return data;
  const entries = Object.entries(data).map(([key, value]) => {
    if (QUERY_KEYS.includes(key)) return [key, REDACTED];
    if (URL_KEYS.includes(key) && typeof value === 'string') return [key, redactSecretsInUrl(value)];
    return [key, value];
  });
  return Object.fromEntries(entries);
}

export function scrubBreadcrumb<T extends Bag>(breadcrumb: T): T {
  return {
    ...breadcrumb,
    ...(typeof breadcrumb.message === 'string' ? { message: redactSecretsInText(breadcrumb.message) } : {}),
    ...(breadcrumb.data !== undefined ? { data: scrubData(breadcrumb.data) } : {}),
  };
}

function scrubHeaders(headers: unknown): unknown {
  if (!isBag(headers)) return headers;
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => {
      const lk = k.toLowerCase();
      return SECRET_HEADERS.has(lk) || lk.startsWith('x-csrf') ? [k, REDACTED] : [k, v];
    }),
  );
}

function scrubBody(data: unknown): unknown {
  if (!isBag(data)) return data;
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, SECRET_BODY_KEYS.includes(k) ? REDACTED : v]));
}

function scrubRequestUrl(url: string): string {
  try {
    const u = new URL(url, 'http://x');
    // La query entera fuera (query_string también se tapa).
    return url.startsWith('http') ? `${u.origin}${redactSecretsInUrl(u.pathname)}` : redactSecretsInUrl(u.pathname);
  } catch {
    return REDACTED;
  }
}

function scrubRequest(request: unknown): unknown {
  if (!isBag(request)) return request;
  return {
    ...request,
    ...(typeof request.url === 'string' ? { url: scrubRequestUrl(request.url) } : {}),
    ...('query_string' in request ? { query_string: REDACTED } : {}),
    ...('headers' in request ? { headers: scrubHeaders(request.headers) } : {}),
    ...('data' in request ? { data: scrubBody(request.data) } : {}),
    ...('cookies' in request ? { cookies: REDACTED } : {}),
  };
}

function scrubBreadcrumbs(breadcrumbs: unknown): unknown {
  if (Array.isArray(breadcrumbs)) return breadcrumbs.map((b) => (isBag(b) ? scrubBreadcrumb(b) : b));
  if (isBag(breadcrumbs) && Array.isArray(breadcrumbs.values)) {
    return { ...breadcrumbs, values: scrubBreadcrumbs(breadcrumbs.values) };
  }
  return breadcrumbs;
}

function scrubSpan(span: unknown): unknown {
  if (!isBag(span)) return span;
  return {
    ...span,
    ...(typeof span.description === 'string' ? { description: redactSecretsInText(span.description) } : {}),
    ...(span.data !== undefined ? { data: scrubData(span.data) } : {}),
  };
}

function scrubContexts(contexts: unknown): unknown {
  if (!isBag(contexts) || !isBag(contexts.trace)) return contexts;
  return { ...contexts, trace: scrubSpan(contexts.trace) };
}

/** Evento de error o transacción, ya limpio (copia; el original no se toca). */
export function scrubSensitive<T extends Bag>(event: T): T {
  return {
    ...event,
    ...('request' in event ? { request: scrubRequest(event.request) } : {}),
    ...(typeof event.transaction === 'string' ? { transaction: redactSecretsInText(event.transaction) } : {}),
    ...('breadcrumbs' in event ? { breadcrumbs: scrubBreadcrumbs(event.breadcrumbs) } : {}),
    ...(Array.isArray(event.spans) ? { spans: event.spans.map(scrubSpan) } : {}),
    ...('contexts' in event ? { contexts: scrubContexts(event.contexts) } : {}),
  };
}
