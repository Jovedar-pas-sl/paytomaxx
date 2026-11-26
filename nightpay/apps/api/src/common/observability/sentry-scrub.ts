import { redactPartnerSecrets, redactSecretsInText, redactSecretsInUrl } from '../logging/redact-url';

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
/**
 * Campos del cuerpo de la petición que nunca salen, a cualquier profundidad
 * (en minúsculas: se comparan sin distinguir mayúsculas).
 */
const SECRET_BODY_KEYS: ReadonlySet<string> = new Set([
  'password',
  'passportlast4',
  'payoutaddress',
  'token',
  'refreshtoken',
  'externaltxid',
  'pin',
  'pin2',
  'secret',
  'tokenizationdata',
  'ds_merchantparameters',
  'ds_signature',
  // Login en dos pasos y 2FA: el ticket de la contraseña y el código.
  'loginticket',
  'ticket',
  'totpcode',
  'code',
  // Llaves (passkeys): la respuesta firmada del móvil.
  'response',
  'credential',
  'assertion',
  'attestation',
  // Lo que identifica un saldo sin el móvil del cliente: enlace, QR, ficha NFC.
  'wallettoken',
  'qrtoken',
  'paytoken',
  'card',
  'uid',
  // Datos personales de las altas y de los pagos (FSD-08): contacto, cuenta
  // de cobro (también fuera de payoutAddress), titular, banco y SWIFT.
  'phone',
  'email',
  'payoutmetadata',
  'payoutlabel',
  'accountholder',
  'bankname',
  'swiftbic',
  'swift',
  'bic',
  'iban',
  'accountnumber',
  'passportcountry',
  // El alta: nombre legal y fecha de nacimiento.
  'legalname',
  'birthdate',
  // API de socios: lo que identifica un saldo (QR, chip) y el texto del socio.
  'qr',
  'nfc_uid',
  'description',
  // …y el motivo de una anulación (solo en sus columnas y el panel).
  'reason',
]);
/**
 * Y cualquiera que lo parezca: newPassword, accessToken, pinConfirm,
 * clientSecret, userEmail, ownerPhone, payoutIban…
 */
const SECRET_KEY_PATTERNS: ReadonlyArray<RegExp> = [/password/i, /secret/i, /token$/i, /^pin/i, /phone/i, /email/i, /iban/i];
/** Un IBAN en cualquier valor (junto o en grupos de 4): se tapa aunque el campo no lo diga. */
const IBAN_IN_TEXT = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/gi;
const HAS_IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/i;
/** Más hondo que esto no se mira: se tapa entero (un JSON de 1 MB puede anidar mucho). */
const MAX_SCRUB_DEPTH = 32;
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

function isSecretKey(key: string): boolean {
  return SECRET_BODY_KEYS.has(key.toLowerCase()) || SECRET_KEY_PATTERNS.some((re) => re.test(key));
}

/** IBAN, claves de socio (oxp_…) y códigos del móvil (OXC1:…) en cualquier texto. */
function maskIbans(text: string): string {
  return redactPartnerSecrets(text.replace(IBAN_IN_TEXT, REDACTED));
}

/** Un texto libre (el mensaje del evento, el de una excepción): URLs con token, IBAN y claves. */
function scrubText(text: string): string {
  return maskIbans(redactSecretsInText(text));
}

/** Copia sin los campos secretos, en todos los niveles (objetos y listas). */
function scrubValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return maskIbans(value);
  if (typeof value !== 'object' || value === null) return value;
  if (depth > MAX_SCRUB_DEPTH) return REDACTED;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1, seen));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, isSecretKey(k) ? REDACTED : scrubValue(v, depth + 1, seen)]),
  );
}

const FORM_BODY = /^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)*$/;

function decodeFormKey(key: string): string {
  try {
    return decodeURIComponent(key.replace(/\+/g, ' '));
  } catch {
    return key;
  }
}

/**
 * El SDK de Sentry guarda el cuerpo como texto: JSON → limpio por dentro;
 * formulario (avisos de Redsys y Cecabank) → sin los valores sensibles; otra
 * cosa → no se manda.
 */
function scrubBodyText(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return text;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(scrubValue(JSON.parse(trimmed), 0, new WeakSet()));
    } catch {
      return REDACTED;
    }
  }
  if (!FORM_BODY.test(trimmed)) return REDACTED;
  return trimmed
    .split('&')
    .map((pair) => {
      const key = pair.slice(0, pair.indexOf('='));
      if (isSecretKey(decodeFormKey(key))) return `${key}=${REDACTED}`;
      return HAS_IBAN.test(decodeFormKey(pair)) ? `${key}=${REDACTED}` : pair;
    })
    .join('&');
}

function scrubBody(data: unknown): unknown {
  return typeof data === 'string' ? scrubBodyText(data) : scrubValue(data, 0, new WeakSet());
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

/** Las excepciones del evento con su texto (`value`) limpio. */
function scrubException(exception: unknown): unknown {
  if (!isBag(exception) || !Array.isArray(exception.values)) return exception;
  return {
    ...exception,
    values: exception.values.map((v) => (isBag(v) && typeof v.value === 'string' ? { ...v, value: scrubText(v.value) } : v)),
  };
}

/** Evento de error o transacción, ya limpio (copia; el original no se toca). */
export function scrubSensitive<T extends Bag>(event: T): T {
  return {
    ...event,
    ...(typeof event.message === 'string' ? { message: scrubText(event.message) } : {}),
    ...('exception' in event ? { exception: scrubException(event.exception) } : {}),
    ...('request' in event ? { request: scrubRequest(event.request) } : {}),
    ...('extra' in event ? { extra: scrubValue(event.extra, 0, new WeakSet()) } : {}),
    ...(typeof event.transaction === 'string' ? { transaction: redactSecretsInText(event.transaction) } : {}),
    ...('breadcrumbs' in event ? { breadcrumbs: scrubBreadcrumbs(event.breadcrumbs) } : {}),
    ...(Array.isArray(event.spans) ? { spans: event.spans.map(scrubSpan) } : {}),
    ...('contexts' in event ? { contexts: scrubContexts(event.contexts) } : {}),
  };
}
