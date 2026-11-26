import { z } from 'zod';
import { WALLET_REF_DETAIL } from './wallet';
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
  idempotency_key_missing: {
    status: 400,
    title: 'Idempotency key missing',
    en: 'This route needs the Idempotency-Key header.',
    es: 'Carga sin `Idempotency-Key`',
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
  limit_exceeded: {
    status: 402,
    title: 'Limit exceeded',
    en: 'A load limit refuses this load (`limit`)',
    es: 'Un tope de carga no deja hacer esta carga (`limit`)',
  },
  cash_limit_reached: {
    status: 402,
    title: 'Cash limit reached',
    en: 'Cash into this wallet would reach 1,000.00 EUR within 24 hours, counting reception and every partner.',
    es: 'El efectivo de este saldo llegaría a 1.000 € en 24 h (recepción y cajeros juntos)',
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
  wallet_not_found: {
    status: 404,
    title: 'Wallet not found',
    en: 'No wallet within this key\'s reach matches this reference.',
    es: 'No hay saldo a vuestro alcance con esa referencia (no existe, otro grupo u otra sociedad)',
  },
  load_not_found: {
    status: 404,
    title: 'Load not found',
    en: 'This connection has no load with this id.',
    es: 'Esa carga no es de esta conexión',
  },
  wallet_blocked: { status: 409, title: 'Wallet blocked', en: 'Wallet blocked', es: 'Saldo bloqueado' },
  wallet_closed: { status: 409, title: 'Wallet closed', en: 'Wallet closed', es: 'Saldo cerrado' },
  ficha_lost: { status: 409, title: 'Ficha lost', en: 'Ficha reported lost', es: 'Ficha dada como perdida' },
  ficha_blocked: { status: 409, title: 'Ficha blocked', en: 'Ficha blocked', es: 'Ficha bloqueada' },
  ficha_copy_suspected: {
    status: 409,
    title: 'Ficha copy suspected',
    en: 'The chip\'s serial does not match this ficha.',
    es: 'El número del chip no es el de la ficha; el dueño recibe aviso',
  },
  method_disabled: {
    status: 409,
    title: 'Method disabled',
    en: 'The venue switched this method off in its settings (`method`, `reason: venue_setting`)',
    es: 'El local apagó esta forma de cobro en sus ajustes (`method`, `reason: venue_setting`)',
  },
  void_window_passed: {
    status: 409,
    title: 'Void window passed',
    en: 'A load can be voided only within 10 minutes of its creation. The venue can correct it from its panel.',
    es: 'Anulación pasados los 10 minutos',
  },
  balance_already_spent: {
    status: 409,
    title: 'Balance already spent',
    en: 'The wallet no longer holds the amount of this load. The venue can correct it from its panel.',
    es: 'El saldo ya no cubre la carga que se quería anular (`available`)',
  },
  body_too_large: { status: 413, title: 'Body too large', en: 'Body over 16 KB', es: 'Cuerpo de más de 16 KB' },
  validation_failed: {
    status: 422,
    title: 'Validation failed',
    en: 'A field breaks its rule (`param`), an extra field, `nfc_uid` with a phone code, or a card number in `reference`',
    es: 'Un campo incumple su regla (`param`), un campo de más, `nfc_uid` con un código del móvil, o un número de tarjeta en `reference`',
  },
  wallet_ref_unrecognized: {
    status: 422,
    title: 'Wallet reference unrecognized',
    en: 'What was read is nothing of OxioPay\'s',
    es: 'Lo leído no es nada de OxioPay',
  },
  wallet_ref_not_accepted: {
    status: 422,
    title: 'Wallet reference not accepted',
    en: 'It is OxioPay\'s but does not work here (`reason`, chapter 3)',
    es: 'Es de OxioPay pero no sirve aquí (`reason`, capítulo 3)',
  },
  live_code_invalid: {
    status: 422,
    title: 'Live code invalid',
    en: 'This live code is expired or unknown. Ask the customer to show the code again.',
    es: 'Código del móvil caducado o desconocido',
  },
  description_invalid: {
    status: 422,
    title: 'Description invalid',
    en: '`description` with characters or links that are not allowed',
    es: '`description` con caracteres o enlaces no permitidos',
  },
  description_personal_data: {
    status: 422,
    title: 'Description holds personal data',
    en: 'The description looks like it holds personal data (an email, a phone or a card number).',
    es: '`description` parece un dato personal (correo, 9 cifras o más, tarjeta)',
  },
  funding_not_allowed: {
    status: 422,
    title: 'Funding not allowed',
    en: 'This connection does not accept this funding.',
    es: 'Esta conexión no admite esta forma de pago.',
  },
  idempotency_key_reused: {
    status: 422,
    title: 'Idempotency key reused',
    en: 'This Idempotency-Key already holds another request. Read that operation; never make a new key for the same load.',
    es: 'Esa `Idempotency-Key` ya tiene otra operación (`operation`)',
  },
  range_too_long: {
    status: 422,
    title: 'Range too long',
    en: 'The period can be at most 31 days.',
    es: 'Periodo demasiado largo en el cuadre',
  },
  venue_paused: {
    status: 423,
    title: 'Venue paused',
    en: 'The venue is paused and takes no loads now.',
    es: 'El local (o su sociedad) está en pausa',
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

/** Los topes de carga del contrato (en su orden: si saltan varios, se nombra el primero). */
export const PARTNER_LOAD_LIMITS = ['per_operation', 'wallet_24h', 'wallet_24h_all_partners', 'unnamed_wallet_30d', 'connection_night'] as const;
export type PartnerLoadLimit = (typeof PARTNER_LOAD_LIMITS)[number];

const euros = (cents: number) => (cents / 100).toFixed(2);

/**
 * El `detail` de `402 limit_exceeded` según su `limit` (capítulo 5); en inglés,
 * `per_operation` dice el tope de la conexión, como el ejemplo del contrato.
 */
export function loadLimitDetail(limit: PartnerLoadLimit, perOperationCents: number): { en: string; es: string } {
  switch (limit) {
    case 'per_operation':
      return { en: `This load is above this connection's limit per operation (${euros(perOperationCents)} EUR).`, es: 'Más que el máximo por recarga' };
    case 'wallet_24h':
      return { en: "This wallet's 24 h limit at these ATMs", es: 'Tope de este saldo en 24 h en estos cajeros' };
    case 'wallet_24h_all_partners':
      return { en: "This wallet's 24 h limit across all partners", es: 'Tope de este saldo en 24 h entre todos los socios' };
    case 'unnamed_wallet_30d':
      return { en: '1,500 € in 30 days on a wallet without a phone', es: '1.500 € en 30 días en un saldo sin teléfono' };
    case 'connection_night':
      return { en: "The night limit of all the venue's ATMs", es: 'Tope de la noche de todos los cajeros del local' };
  }
}

/** El `detail` de `409 method_disabled` según su `method` (el de `wallet`, el del ejemplo del contrato). */
export const METHOD_DISABLED_DETAIL = {
  wallet: { en: 'This venue does not take balance loads now.', es: 'El local apagó el saldo en sus ajustes (`reason: venue_setting`)' },
  cash_top_up: {
    en: 'The venue switched cash top-ups off in its settings (`reason: venue_setting`)',
    es: 'El local apagó las recargas en efectivo en sus ajustes (`reason: venue_setting`)',
  },
} as const;

/** El `detail` de `422 range_too_long` según el tope del periodo (31 días en la lista, 92 en el resumen). */
export function rangeTooLongDetail(maxDays: number): { en: string; es: string } {
  return { en: `The period can be at most ${maxDays} days.`, es: 'Periodo demasiado largo en el cuadre' };
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
  /** Los ejemplos (components.examples), cada uno con su código (o su `key`) como nombre. */
  readonly examples?: readonly PartnerProblemExampleName[];
  /** 429 y 503 llevan Retry-After. */
  readonly retryAfter?: boolean;
}

const FORBIDDEN_BASE = ['ip_not_allowed', 'browser_not_allowed', 'partner_suspended', 'connection_paused'] as const;

export const PARTNER_ERROR_RESPONSES = {
  BadRequest: {
    description:
      '`invalid_request`: the body is not a JSON object (an array, a string, an empty body where one is needed), the\ncontent type is not `application/json`, or the request cannot be read (`param` when it names one place).\n`api_key_in_url` / `api_key_in_body`: a key was sent outside the Authorization header.\n',
    codes: ['invalid_request', 'api_key_in_url', 'api_key_in_body'],
    examples: ['ProblemKeyInUrl'],
  },
  Unauthorized: {
    description: 'The key is not usable. Do not retry; the ATM platform\'s operators must act.',
    codes: ['invalid_api_key', 'api_key_rotated', 'api_key_revoked', 'api_key_expired', 'api_key_suspended', 'wrong_environment'],
    examples: ['ProblemInvalidKey'],
  },
  ForbiddenAnyScope: { description: 'Refused before any data is read.', codes: [...FORBIDDEN_BASE], examples: ['ProblemIpNotAllowed'] },
  ForbiddenScoped: {
    description: 'Refused before any data is read, or the key lacks the scope (or `wallet:balance` is paused).',
    codes: ['scope_missing', 'scope_paused', ...FORBIDDEN_BASE],
    examples: ['ProblemScopeMissing'],
  },
  ForbiddenRead: {
    description:
      'Refused before any data is read, or the key lacks the scope. A pause of `wallet:load` and the money freeze do\nnot refuse this route: an open transaction can always be looked up and reconciled.\n',
    codes: ['scope_missing', ...FORBIDDEN_BASE],
    examples: ['ProblemScopeMissing'],
  },
  ForbiddenVoid: {
    description:
      'As `ForbiddenRead`, plus `partner_api_frozen` when OxioPay froze money operations. A pause of `wallet:load` does\nnot refuse a void.\n',
    codes: ['scope_missing', ...FORBIDDEN_BASE, 'partner_api_frozen'],
    examples: ['ProblemApiFrozen'],
  },
  ForbiddenMoney: {
    description:
      'As for any scoped route, plus `scope_paused` while new loads are paused and `partner_api_frozen` when OxioPay\nfroze money operations.\n',
    codes: ['scope_missing', 'scope_paused', ...FORBIDDEN_BASE, 'partner_api_frozen'],
    examples: ['ProblemScopePaused'],
  },
  LoadBadRequest: {
    description: 'Malformed request, missing Idempotency-Key, or a key in the URL or body.',
    codes: ['invalid_request', 'idempotency_key_missing', 'api_key_in_url', 'api_key_in_body'],
    examples: ['ProblemIdempotencyKeyMissing'],
  },
  LoadLimit: {
    description: 'A limit refuses this load. Nothing was loaded. `cash_limit_reached` uses the same status as the other limits.',
    codes: ['limit_exceeded', 'cash_limit_reached'],
    examples: ['ProblemPerOperation', 'ProblemCashLimit'],
  },
  LoadWalletUnusable: {
    description: 'The wallet or the ficha cannot be used, or the venue switched off balance or cash top-ups.',
    codes: ['wallet_blocked', 'wallet_closed', 'ficha_lost', 'ficha_blocked', 'ficha_copy_suspected', 'method_disabled'],
    examples: ['ProblemMethodDisabled'],
  },
  LoadInvalid: {
    description: 'The request breaks a rule, the reference is not usable, or the Idempotency-Key was used for another request.',
    codes: [
      'validation_failed',
      'wallet_ref_unrecognized',
      'wallet_ref_not_accepted',
      'live_code_invalid',
      'description_invalid',
      'description_personal_data',
      'funding_not_allowed',
      'idempotency_key_reused',
    ],
    examples: ['ProblemFundingCard', 'ProblemIdempotencyKeyReused', 'ProblemDescriptionPersonalData'],
  },
  VenuePaused: { description: 'The venue (or its company) is paused.', codes: ['venue_paused'], examples: ['ProblemVenuePaused'] },
  LoadNotFound: {
    description: "Not one of this connection's loads, or the API is switched off.",
    codes: ['load_not_found', 'not_found'],
    examples: ['ProblemLoadNotFound'],
  },
  VoidConflict: {
    description: 'The load can no longer be voided through the API. Nothing changed.',
    codes: ['void_window_passed', 'balance_already_spent'],
    examples: ['ProblemVoidWindow', 'ProblemBalanceSpent'],
  },
  RangeOrValidation: {
    description: '`range_too_long`: the period is longer than 31 days. `validation_failed`: a parameter breaks its rule (`param`).',
    codes: ['range_too_long', 'validation_failed'],
    examples: ['ProblemRangeTooLong'],
  },
  StatementRangeOrValidation: {
    description: '`range_too_long`: the period is longer than 92 days. `validation_failed`: a parameter breaks its rule (`param`).',
    codes: ['range_too_long', 'validation_failed'],
    examples: ['ProblemRangeTooLong92'],
  },
  ApiOff: {
    description:
      '`not_found`: the partner API is switched off, frozen for every route, or the route does not exist here (the\ntest helpers in live). When the API is switched off the body may not be problem+json: treat any 404 on\n`/me` as "API unavailable".\n',
    codes: ['not_found'],
    examples: ['ProblemNotFound'],
  },
  WalletNotFound: {
    description: 'No wallet within the key\'s reach matches the reference, or the API is switched off.',
    codes: ['wallet_not_found', 'not_found'],
    examples: ['ProblemWalletNotFound'],
  },
  WalletUnusable: {
    description: 'The wallet or the ficha cannot be used.',
    codes: ['wallet_blocked', 'wallet_closed', 'ficha_lost', 'ficha_blocked', 'ficha_copy_suspected'],
    examples: ['ProblemFichaCopy'],
  },
  WalletRefInvalid: {
    description: 'The request breaks a rule, or the `qr` text is not a usable wallet reference.',
    codes: ['validation_failed', 'wallet_ref_unrecognized', 'wallet_ref_not_accepted', 'live_code_invalid'],
    examples: ['ProblemPrivateLink', 'ProblemLiveCodeInvalid'],
  },
  PayloadTooLarge: { description: 'The body is larger than 16 KB (16,384 bytes).', codes: ['body_too_large'] },
  ValidationFailed: { description: 'A field breaks its rule; `param` names it.', codes: ['validation_failed'], examples: ['ProblemValidationReason'] },
  RateLimited: {
    description:
      'Too many requests; nothing was done. Retry after `Retry-After`, with the same Idempotency-Key and body. See the\nrate-limit table for each bucket.\n',
    codes: ['rate_limited'],
    examples: ['ProblemRateLimited'],
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
export interface PartnerProblemExampleDef {
  readonly summary: string;
  readonly code: PartnerErrorCode;
  /** Su nombre en `examples` de la respuesta (si no, el código). */
  readonly key?: string;
  /** Campos de más, o un `detail` propio (el del ejemplo del contrato). */
  readonly extra?: Readonly<Record<string, unknown>>;
}

export const PARTNER_PROBLEM_EXAMPLES = {
  ProblemKeyInUrl: { summary: 'The key was sent in the URL', code: 'api_key_in_url' },
  ProblemInvalidKey: { summary: 'Not a valid key', code: 'invalid_api_key' },
  ProblemIpNotAllowed: { summary: 'Called from an address not registered for this key', code: 'ip_not_allowed' },
  ProblemScopeMissing: { summary: 'The key lacks the scope', code: 'scope_missing', extra: { required_scope: 'wallet:load' } },
  ProblemScopePaused: {
    summary: 'Loads paused for this connection',
    code: 'scope_paused',
    extra: { detail: 'Loads are paused for this connection until the owner resumes them.' },
  },
  ProblemApiFrozen: { summary: 'OxioPay froze money operations', code: 'partner_api_frozen' },
  ProblemNotFound: { summary: 'The partner API is not available here', code: 'not_found' },
  ProblemRateLimited: { summary: 'Too many requests', code: 'rate_limited' },
  ProblemValidationReason: {
    summary: 'A field breaks its rule',
    code: 'validation_failed',
    extra: { detail: 'reason must be 1 to 140 characters.', param: 'reason' },
  },
  ProblemWalletNotFound: { summary: 'Unknown, or outside the key\'s reach', code: 'wallet_not_found' },
  ProblemFichaCopy: { summary: 'The chip\'s serial is not the ficha\'s', code: 'ficha_copy_suspected' },
  ProblemPrivateLink: {
    summary: 'The customer showed their private wallet link',
    code: 'wallet_ref_not_accepted',
    extra: { reason: 'private_link', detail: WALLET_REF_DETAIL.private_link.en },
  },
  ProblemLiveCodeInvalid: { summary: 'Expired or unknown live code', code: 'live_code_invalid' },
  ProblemPerOperation: {
    summary: 'Above the limit per operation',
    code: 'limit_exceeded',
    key: 'per_operation',
    extra: { detail: loadLimitDetail('per_operation', 30000).en, limit: 'per_operation', remaining: 30000 },
  },
  ProblemCashLimit: { summary: 'Cash would reach 1,000 € in 24 hours', code: 'cash_limit_reached' },
  ProblemVenuePaused: { summary: 'The venue is paused', code: 'venue_paused' },
  ProblemIdempotencyKeyMissing: { summary: 'No Idempotency-Key', code: 'idempotency_key_missing' },
  ProblemMethodDisabled: {
    summary: 'The venue switched balance off',
    code: 'method_disabled',
    extra: { detail: METHOD_DISABLED_DETAIL.wallet.en, method: 'wallet', reason: 'venue_setting' },
  },
  ProblemFundingCard: { summary: 'Card is not enabled for this connection', code: 'funding_not_allowed' },
  ProblemIdempotencyKeyReused: {
    summary: 'The key already holds another load',
    code: 'idempotency_key_reused',
    extra: {
      operation: {
        object: 'wallet_load',
        id: 'wl_8b2e6f1a9c3d4e5f8a7b6c5d4e3f2a1b',
        status: 'succeeded',
        amount: 2000,
        created_at: '2026-12-05T22:41:07Z',
      },
    },
  },
  ProblemDescriptionPersonalData: { summary: 'The description holds a long number', code: 'description_personal_data' },
  ProblemVoidWindow: { summary: 'More than 10 minutes after the load', code: 'void_window_passed' },
  ProblemBalanceSpent: { summary: 'The customer already spent part of the load', code: 'balance_already_spent', extra: { available: 1500 } },
  ProblemLoadNotFound: { summary: "Not one of this connection's loads", code: 'load_not_found' },
  ProblemRangeTooLong: { summary: 'The period is too long', code: 'range_too_long' },
  ProblemRangeTooLong92: {
    summary: 'The period of a statement is too long',
    code: 'range_too_long',
    key: 'range_too_long',
    extra: { detail: rangeTooLongDetail(92).en },
  },
} as const satisfies Record<string, PartnerProblemExampleDef>;

export type PartnerProblemExampleName = keyof typeof PARTNER_PROBLEM_EXAMPLES;

/** El `request_id` de los ejemplos del contrato. */
export const PARTNER_EXAMPLE_REQUEST_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
