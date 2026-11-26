import { z } from 'zod';
import { PARTNER_DOCS_HOST, PartnerLoadIdSchema, PartnerScopeSchema, PartnerTimestampSchema, partnerSchemas } from './common';

// Catálogo de errores de la API de socios (§4.8 del diseño, capítulo 5 de
// las guías). `title` siempre en inglés; `en`/`es` son el `detail` según
// `Accept-Language`. Textos: los de los ejemplos del contrato; si no hay
// ejemplo, el código en palabras y «What it means» / «Qué significa».
// Un código nuevo entra aquí antes de que el código lo use (partner-problem.spec.ts).

export interface PartnerErrorDef {
  readonly status: number;
  readonly title: string;
  readonly en: string;
  readonly es: string;
}

export const PARTNER_ERRORS = {
  invalid_request: {
    status: 400,
    title: 'Invalid request',
    en: 'Unreadable request: a body that is not a JSON object, a `Content-Type` other than `application/json`, a badly formatted `Idempotency-Key`',
    es: 'Petición ilegible: cuerpo que no es un objeto JSON, `Content-Type` distinto de `application/json`, `Idempotency-Key` con formato malo',
  },
  api_key_in_url: {
    status: 400,
    title: 'API key in URL',
    en: 'Send the key only in the Authorization header. Ask the owner to rotate this key.',
    es: 'La clave iba en la URL; el dueño recibe aviso para rotarla',
  },
  api_key_in_body: { status: 400, title: 'API key in body', en: 'The key was in the body', es: 'La clave iba en el cuerpo' },
  invalid_api_key: {
    status: 401,
    title: 'Invalid API key',
    en: 'This key is not valid.',
    es: 'Clave desconocida (o bloqueada 15 minutos tras 20 fallos)',
  },
  api_key_rotated: {
    status: 401,
    title: 'API key rotated',
    en: 'The key was replaced by another one and the overlap is over',
    es: 'La clave se cambió por otra y el solape acabó',
  },
  api_key_revoked: { status: 401, title: 'API key revoked', en: 'Key revoked', es: 'Clave revocada' },
  api_key_expired: { status: 401, title: 'API key expired', en: 'Key expired', es: 'Clave caducada' },
  api_key_suspended: {
    status: 401,
    title: 'API key suspended',
    en: '90 days without wallet calls; the owner reactivates it',
    es: '90 días sin llamadas de saldo; el dueño la reactiva',
  },
  wrong_environment: {
    status: 401,
    title: 'Wrong environment',
    en: 'A test key in live or a live key on the demo',
    es: 'Clave de prueba en real o real en la demo',
  },
  scope_missing: {
    status: 403,
    title: 'Scope missing',
    en: 'This key does not hold the scope this route needs.',
    es: 'La clave no tiene ese permiso (`required_scope`)',
  },
  scope_paused: {
    status: 403,
    title: 'Scope paused',
    en: 'This scope is paused for this connection until the owner resumes it.',
    es: 'Ese permiso está en pausa en esta conexión hasta que el dueño lo reanude.',
  },
  ip_not_allowed: {
    status: 403,
    title: 'IP not allowed',
    en: 'This key cannot be used from this address.',
    es: 'Llamada desde una IP no registrada; el dueño recibe aviso',
  },
  browser_not_allowed: {
    status: 403,
    title: 'Browser not allowed',
    en: 'The request carried an `Origin` header',
    es: 'La petición llevaba cabecera `Origin`',
  },
  partner_suspended: {
    status: 403,
    title: 'Partner suspended',
    en: 'OxioPay suspended your company as a partner',
    es: 'OxioPay suspendió a vuestra empresa como socio',
  },
  connection_paused: {
    status: 403,
    title: 'Connection paused',
    en: 'The owner or OxioPay paused the connection',
    es: 'El dueño u OxioPay pausaron la conexión',
  },
  partner_api_frozen: {
    status: 403,
    title: 'Partner API frozen',
    en: 'OxioPay has frozen loads and voids for now. Reading and reconciling still work.',
    es: 'OxioPay congeló las cargas y las anulaciones',
  },
  not_found: {
    status: 404,
    title: 'Not found',
    en: 'Not found.',
    es: 'API apagada o congelada del todo, o ruta que no existe. Con la API apagada el cuerpo puede no ser JSON',
  },
  body_too_large: { status: 413, title: 'Body too large', en: 'Body over 16 KB', es: 'Cuerpo de más de 16 KB' },
  validation_failed: {
    status: 422,
    title: 'Validation failed',
    en: 'A field breaks its rule (`param`), an extra field, `nfc_uid` with a phone code, or a card number in `reference`',
    es: 'Un campo incumple su regla (`param`), un campo de más, `nfc_uid` con un código del móvil, o un número de tarjeta en `reference`',
  },
  rate_limited: {
    status: 429,
    title: 'Rate limited',
    en: 'Too many requests. Retry after the time in Retry-After.',
    es: 'Demasiadas peticiones; no se hizo nada',
  },
  internal_error: {
    status: 500,
    title: 'Internal error',
    en: 'Unexpected OxioPay failure: it is unknown whether it was loaded',
    es: 'Fallo inesperado de OxioPay: no se sabe si se cargó',
  },
  try_later: {
    status: 503,
    title: 'Try later',
    en: 'OxioPay cannot answer safely right now; nothing was done',
    es: 'OxioPay no puede contestar con seguridad ahora; no se hizo nada',
  },
} as const satisfies Record<string, PartnerErrorDef>;

export type PartnerErrorCode = keyof typeof PARTNER_ERRORS;

export function isPartnerErrorCode(value: unknown): value is PartnerErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PARTNER_ERRORS, value);
}

/** `type` de un problema: la página del código en la documentación. */
export function partnerProblemType(code: string): string {
  return `https://${PARTNER_DOCS_HOST}/errors/${code}`;
}

// ─── Esquemas del contrato: Problem, ErrorCode y OperationRef ──────────

export const PartnerErrorCodeSchema = z.string().register(partnerSchemas, {
  id: 'ErrorCode',
  description:
    'Stable snake_case code. Codes that can appear in this pilot:\n`invalid_request`, `idempotency_key_missing`, `api_key_in_url`, `api_key_in_body`, `invalid_api_key`,\n`api_key_rotated`, `api_key_revoked`, `api_key_expired`, `api_key_suspended`, `wrong_environment`,\n`limit_exceeded`, `cash_limit_reached`, `scope_missing`, `scope_paused`, `ip_not_allowed`,\n`browser_not_allowed`, `partner_suspended`, `connection_paused`, `partner_api_frozen`, `wallet_not_found`,\n`load_not_found`, `not_found`, `wallet_blocked`, `wallet_closed`, `ficha_lost`, `ficha_blocked`,\n`ficha_copy_suspected`, `method_disabled`, `void_window_passed`, `balance_already_spent`, `body_too_large`,\n`validation_failed`, `wallet_ref_unrecognized`, `wallet_ref_not_accepted`, `live_code_invalid`,\n`description_invalid`, `description_personal_data`, `funding_not_allowed`, `idempotency_key_reused`,\n`range_too_long`, `venue_paused`, `rate_limited`, `try_later`, `internal_error`.\n',
});

export const PartnerOperationRefSchema = z
  .object({
    object: z.enum(['wallet_load']),
    id: PartnerLoadIdSchema,
    status: z.enum(['succeeded', 'voided']),
    amount: z.number().int().min(1),
    created_at: PartnerTimestampSchema,
  })
  .register(partnerSchemas, {
    id: 'OperationRef',
    description: 'The operation that already holds this Idempotency-Key.',
    'x-decided-in-contract': true,
  });

export const PartnerProblemSchema = z
  .object({
    type: z.url().register(partnerSchemas, {
      description: '`https://<docs host>/errors/<code>`.',
      examples: ['https://docs.oxiopay.example/errors/limit_exceeded'],
    }),
    title: z.string().register(partnerSchemas, { description: 'Short summary in English, fixed per code.' }),
    status: z.number().int().register(partnerSchemas, { description: 'The HTTP status.' }),
    code: PartnerErrorCodeSchema,
    detail: z.string().register(partnerSchemas, {
      description:
        'Explanation for developers, in the language of `Accept-Language`. It never repeats a value you sent. The ATM shows its own texts to customers.',
    }),
    request_id: z.string().register(partnerSchemas, { description: 'Same value as the `Request-Id` header.' }),
    param: z.string().optional(),
    required_scope: PartnerScopeSchema.optional(),
    limit: z.enum(['per_operation', 'wallet_24h', 'wallet_24h_all_partners', 'unnamed_wallet_30d', 'connection_night']).optional(),
    remaining: z.number().int().min(0).optional(),
    method: z.enum(['wallet', 'cash_top_up']).optional(),
    reason: z
      .enum(['venue_setting', 'wallet_pass', 'private_link', 'reception_qr', 'short_code', 'charge_link', 'other_link'])
      .optional(),
    available: z.number().int().min(0).optional(),
    operation: PartnerOperationRefSchema.optional(),
  })
  .register(partnerSchemas, {
    id: 'Problem',
    description:
      'RFC 9457 problem details. Branch on `code`. The extension members appear only with the codes named in their description.',
  });
export type PartnerProblem = z.infer<typeof PartnerProblemSchema>;

// ─── Respuestas de error del contrato (components.responses) ──────────

export interface PartnerErrorResponseDef {
  readonly description: string;
  readonly codes: readonly PartnerErrorCode[];
  /** El ejemplo (components.examples), con el código como nombre. */
  readonly example?: PartnerProblemExampleName;
  /** 429 y 503 llevan Retry-After. */
  readonly retryAfter?: boolean;
}

const FORBIDDEN_BASE = ['ip_not_allowed', 'browser_not_allowed', 'partner_suspended', 'connection_paused'] as const;

export const PARTNER_ERROR_RESPONSES = {
  BadRequest: {
    description:
      '`invalid_request`: the body is not a JSON object (an array, a string, an empty body where one is needed), the\ncontent type is not `application/json`, or the request cannot be read (`param` when it names one place).\n`api_key_in_url` / `api_key_in_body`: a key was sent outside the Authorization header.\n',
    codes: ['invalid_request', 'api_key_in_url', 'api_key_in_body'],
    example: 'ProblemKeyInUrl',
  },
  Unauthorized: {
    description: 'The key is not usable. Do not retry; the ATM platform\'s operators must act.',
    codes: ['invalid_api_key', 'api_key_rotated', 'api_key_revoked', 'api_key_expired', 'api_key_suspended', 'wrong_environment'],
    example: 'ProblemInvalidKey',
  },
  ForbiddenAnyScope: { description: 'Refused before any data is read.', codes: [...FORBIDDEN_BASE], example: 'ProblemIpNotAllowed' },
  ForbiddenScoped: {
    description: 'Refused before any data is read, or the key lacks the scope (or `wallet:balance` is paused).',
    codes: ['scope_missing', 'scope_paused', ...FORBIDDEN_BASE],
    example: 'ProblemScopeMissing',
  },
  ForbiddenRead: {
    description:
      'Refused before any data is read, or the key lacks the scope. A pause of `wallet:load` and the money freeze do\nnot refuse this route: an open transaction can always be looked up and reconciled.\n',
    codes: ['scope_missing', ...FORBIDDEN_BASE],
    example: 'ProblemScopeMissing',
  },
  ForbiddenVoid: {
    description:
      'As `ForbiddenRead`, plus `partner_api_frozen` when OxioPay froze money operations. A pause of `wallet:load` does\nnot refuse a void.\n',
    codes: ['scope_missing', ...FORBIDDEN_BASE, 'partner_api_frozen'],
    example: 'ProblemApiFrozen',
  },
  ForbiddenMoney: {
    description:
      'As for any scoped route, plus `scope_paused` while new loads are paused and `partner_api_frozen` when OxioPay\nfroze money operations.\n',
    codes: ['scope_missing', 'scope_paused', ...FORBIDDEN_BASE, 'partner_api_frozen'],
    example: 'ProblemScopePaused',
  },
  ApiOff: {
    description:
      '`not_found`: the partner API is switched off, frozen for every route, or the route does not exist here (the\ntest helpers in live). When the API is switched off the body may not be problem+json: treat any 404 on\n`/me` as "API unavailable".\n',
    codes: ['not_found'],
    example: 'ProblemNotFound',
  },
  PayloadTooLarge: { description: 'The body is larger than 16 KB (16,384 bytes).', codes: ['body_too_large'] },
  ValidationFailed: { description: 'A field breaks its rule; `param` names it.', codes: ['validation_failed'], example: 'ProblemValidationReason' },
  RateLimited: {
    description:
      'Too many requests; nothing was done. Retry after `Retry-After`, with the same Idempotency-Key and body. See the\nrate-limit table for each bucket.\n',
    codes: ['rate_limited'],
    example: 'ProblemRateLimited',
    retryAfter: true,
  },
  TryLater: {
    description:
      'OxioPay cannot answer safely right now, and nothing was done: a limiter or the live-code store cannot be read\n(while that store is down every call answers `503`, fichas included, because the limits fail closed), or an\nearlier request with the same Idempotency-Key is still running. Retry after `Retry-After`, with the same\nIdempotency-Key and body.\n',
    codes: ['try_later'],
    retryAfter: true,
  },
  ServerError: {
    description:
      'OxioPay failed. `500 internal_error` carries only the problem fields and `request_id`; another `5xx` may come\nfrom OxioPay\'s edge, and its body may not be JSON. For a load the result is unknown: retry with the same\nIdempotency-Key and body.\n',
    codes: ['internal_error'],
  },
} as const satisfies Record<string, PartnerErrorResponseDef>;

export type PartnerErrorResponseName = keyof typeof PARTNER_ERROR_RESPONSES;

/** Ejemplos de problemas (components.examples): título y texto, los del catálogo. */
export const PARTNER_PROBLEM_EXAMPLES = {
  ProblemKeyInUrl: { summary: 'The key was sent in the URL', code: 'api_key_in_url' },
  ProblemInvalidKey: { summary: 'Not a valid key', code: 'invalid_api_key' },
  ProblemIpNotAllowed: { summary: 'Called from an address not registered for this key', code: 'ip_not_allowed' },
  ProblemScopeMissing: { summary: 'The key lacks the scope', code: 'scope_missing', extra: { required_scope: 'wallet:load' } },
  ProblemScopePaused: { summary: 'Loads paused for this connection', code: 'scope_paused' },
  ProblemApiFrozen: { summary: 'OxioPay froze money operations', code: 'partner_api_frozen' },
  ProblemNotFound: { summary: 'The partner API is not available here', code: 'not_found' },
  ProblemRateLimited: { summary: 'Too many requests', code: 'rate_limited' },
  ProblemValidationReason: {
    summary: 'A field breaks its rule',
    code: 'validation_failed',
    extra: { detail: 'reason must be 1 to 140 characters.', param: 'reason' },
  },
} as const satisfies Record<string, { summary: string; code: PartnerErrorCode; extra?: Record<string, string> }>;

export type PartnerProblemExampleName = keyof typeof PARTNER_PROBLEM_EXAMPLES;

/** El `request_id` de los ejemplos del contrato. */
export const PARTNER_EXAMPLE_REQUEST_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
