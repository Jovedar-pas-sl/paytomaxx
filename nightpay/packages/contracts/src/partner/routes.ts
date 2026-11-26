import { z } from 'zod';
import type { PartnerScope } from './common';
import { PartnerConnectionSchema } from './connection';
import type { PartnerErrorResponseName } from './errors';
import { Statement, WalletBalance, WalletBalanceRequest, WalletLoad, WalletLoadList, WalletLoadRequest, WalletLoadVoidRequest } from './wallet';

// La tabla de rutas de la API de socios: la única fuente. Los controladores
// declaran sus rutas solo con @PartnerRoute(PARTNER_ROUTES.x) (lo comprueba
// partner.wiring.spec.ts) y el documento OpenAPI sale de aquí (openapi.ts):
// no hay ruta sin documentación ni documentación de un campo que no sale.

/** Parámetros del contrato (components.parameters) que usan las rutas hechas. */
export const PARTNER_PARAMETERS = {
  AcceptLanguage: {
    name: 'Accept-Language',
    in: 'header',
    required: false,
    description: 'Language of the problem `detail`. Spanish when the first language is `es`; English otherwise. `title` is always English.',
    'x-decided-in-contract': true,
    schema: { type: 'string' },
    example: 'es',
  },
  XRequestId: {
    name: 'X-Request-Id',
    in: 'header',
    required: false,
    description:
      'Your own id for this request, echoed in `Request-Id` when it matches the pattern; otherwise ignored and OxioPay generates a UUID.',
    'x-decided-in-contract': true,
    schema: { type: 'string', pattern: '^[A-Za-z0-9-]{1,64}$' },
    example: 'atm0042-req-000731-1',
  },
  // Los de las cargas, la lista y el resumen (copiados del contrato; `from` y `to` de /statement, obligatorios, aparte).
  IdempotencyKey: {
    "name": "Idempotency-Key",
    "in": "header",
    "required": true,
    "description": "The ATM's own transaction id: unique per connection forever, the same on every retry of that transaction.\nWhen it is also your `reference` (as recommended), use 8 to 64 characters of `[A-Za-z0-9_-]`, and end it with a\nfew random characters so that nobody can guess the next one. Missing → `400 idempotency_key_missing`. Present\nbut not matching the pattern → `400 invalid_request` with `param: \"Idempotency-Key\"`. Ignored on routes that do\nnot require it.\n",
    "x-decided-in-contract": true,
    "schema": {
      "type": "string",
      "pattern": "^[A-Za-z0-9_-]{8,200}$"
    },
    "example": "ATM0042-20261205-000731-K7QM"
  },
  LoadId: {
    "name": "id",
    "in": "path",
    "required": true,
    "description": "The load id (`wl_` + 32 hex). Anything that is not one of this connection's loads answers `404 load_not_found`.",
    "x-decided-in-contract": true,
    "schema": {
      "type": "string",
      "pattern": "^wl_[0-9a-f]{32}$"
    },
    "example": "wl_8b2e6f1a9c3d4e5f8a7b6c5d4e3f2a1b"
  },
  BusinessDate: {
    "name": "business_date",
    "in": "query",
    "required": false,
    "description": "The venue's night (08:00 to 08:00 Europe/Madrid), named after the day it starts. Use it instead of `from` and `to`.",
    "schema": {
      "type": "string",
      "format": "date"
    },
    "example": "2026-12-05"
  },
  From: {
    "name": "from",
    "in": "query",
    "required": false,
    "description": "Start, included. With `to`, instead of `business_date`. RFC 3339 (`Z` or an offset).",
    "schema": {
      "type": "string",
      "format": "date-time"
    },
    "example": "2026-12-05T22:30:00Z"
  },
  To: {
    "name": "to",
    "in": "query",
    "required": false,
    "description": "End, excluded. At most 31 days after `from`; may be in the future.",
    "schema": {
      "type": "string",
      "format": "date-time"
    },
    "example": "2026-12-05T22:45:00Z"
  },
  ReferenceFilter: {
    "name": "reference",
    "in": "query",
    "required": false,
    "description": "Only loads whose `reference` is exactly this text.",
    "schema": {
      "$ref": "#/components/schemas/Reference"
    },
    "example": "ATM0042-20261205-000731-K7QM"
  },
  OperationType: {
    "name": "type",
    "in": "query",
    "required": false,
    "description": "`load`. In this pilot the list holds only loads; `payment` comes with paying with balance.",
    "x-decided-in-contract": true,
    "schema": {
      "type": "string",
      "enum": [
        "load"
      ]
    },
    "example": "load"
  },
  Limit: {
    "name": "limit",
    "in": "query",
    "required": false,
    "description": "Page size.",
    "schema": {
      "type": "integer",
      "minimum": 1,
      "maximum": 100,
      "default": 25
    },
    "example": 25
  },
  Cursor: {
    "name": "cursor",
    "in": "query",
    "required": false,
    "description": "The `next_cursor` of the previous page, sent with the same filters. A cursor that cannot be read with these filters → `422 validation_failed` (`param: \"cursor\"`).",
    "x-decided-in-contract": true,
    "schema": {
      "type": "string",
      "minLength": 1,
      "maxLength": 512
    }
  },
  StatementFrom: {
    "name": "from",
    "in": "query",
    "required": true,
    "description": "Start of the period, included. RFC 3339 (`Z` or an offset).",
    "schema": {
      "type": "string",
      "format": "date-time"
    },
    "example": "2026-12-05T07:00:00Z"
  },
  StatementTo: {
    "name": "to",
    "in": "query",
    "required": true,
    "description": "End of the period, excluded. At most 92 days after `from`.",
    "schema": {
      "type": "string",
      "format": "date-time"
    },
    "example": "2026-12-06T07:00:00Z"
  },
} as const;
export type PartnerParameterName = keyof typeof PARTNER_PARAMETERS;

/** Cabeceras del contrato (components.headers) que usan las rutas hechas. */
export const PARTNER_HEADERS = {
  RequestId: {
    description: 'The id of this request (your valid `X-Request-Id`, or a UUID). Also in every problem as `request_id`.',
    schema: { type: 'string' },
    example: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
  },
  RetryAfter: {
    description: 'Seconds to wait before retrying. Over a per-night limit, the seconds until 08:00 Madrid.',
    'x-decided-in-contract': true,
    schema: { type: 'integer', minimum: 1 },
    example: 30,
  },
  IdempotentReplayed: {
    "description": "Present, with the value `true`, when the answer is the stored answer of an earlier request with the same Idempotency-Key.",
    "schema": {
      "type": "string",
      "enum": [
        "true"
      ]
    }
  },
} as const;
export type PartnerHeaderName = keyof typeof PARTNER_HEADERS;

/** Los estados de error de una ruta y su respuesta del contrato ('5XX' incluido). */
export type PartnerErrorResponses = Readonly<Partial<Record<'400' | '401' | '402' | '403' | '404' | '409' | '413' | '422' | '423' | '429' | '503' | '5XX', PartnerErrorResponseName>>>;

export interface PartnerRouteDef {
  readonly method: 'GET' | 'POST';
  /** Relativa a /v1/partner (como en el contrato). */
  readonly path: string;
  readonly operationId: string;
  readonly tag: string;
  readonly summary: string;
  readonly description: string;
  /** Basta uno; 'any' = cualquier clave válida; vacía = sin clave. */
  readonly scopes: readonly (PartnerScope | 'any')[];
  /** Mueve dinero: la congelación `money` y el tope de 120/min. */
  readonly money: boolean;
  readonly successStatus: 200 | 201 | 204;
  /** Lo que sale de verdad: el interceptor lo pasa por aquí (lo de más se quita). */
  readonly response: z.ZodType;
  readonly successHeaders: readonly PartnerHeaderName[];
  readonly parameters: readonly PartnerParameterName[];
  readonly errorResponses: PartnerErrorResponses;
  /** Ejemplos de la respuesta buena: nombre → components.examples. */
  readonly responseExamples?: Readonly<Record<string, PartnerExampleName>>;
  readonly body?: z.ZodType;
  /** El cuerpo es opcional (anular): `requestBody.required: false`. */
  readonly bodyRequired?: false;
  readonly bodyExamples?: Readonly<Record<string, PartnerExampleName>>;
}

/** Ejemplos de respuestas buenas (components.examples). */
export type PartnerExampleName =
  | 'ConnectionAtm'
  | 'BalanceRequestFicha'
  | 'BalanceRequestLiveCode'
  | 'Balance5000'
  | 'LoadRequestCash'
  | 'LoadCreated'
  | 'LoadRead'
  | 'VoidRequest'
  | 'LoadVoided'
  | 'LoadListByReference'
  | 'StatementNight';

const ANY_KEY_ERRORS = {
  '400': 'BadRequest',
  '401': 'Unauthorized',
  '403': 'ForbiddenAnyScope',
  '404': 'ApiOff',
  '413': 'PayloadTooLarge',
  '429': 'RateLimited',
  '503': 'TryLater',
  '5XX': 'ServerError',
} as const satisfies PartnerErrorResponses;

export const PARTNER_ROUTES = {
  getConnection: {
    method: 'GET',
    path: '/me',
    operationId: 'getConnection',
    tag: 'Connection',
    summary: 'The key\'s connection, its limits and the terms to show',
    description:
      'Works with any valid key. Call it when the ATM platform starts and at least once an hour: it gives the issuer\nand venue for the ticket, the limits, the terms the ATM shows on screen (read it again whenever a load answer\ncarries another `terms.version`), the paused scopes and the key\'s expiry and replacement.\n\nWallet calls (`/wallet/balance`, loads, voids, `/wallet/operations`, `/statement`) keep the key from going\ndormant; `GET /me` does not: 90 days without a wallet call suspend the key (`401 api_key_suspended`).\n\nIt answers only while the connection is active: a paused connection gets `403 connection_paused` and a revoked\nkey `401 api_key_revoked`.\n',
    scopes: ['any'],
    money: false,
    successStatus: 200,
    response: PartnerConnectionSchema,
    successHeaders: ['RequestId'],
    parameters: ['AcceptLanguage', 'XRequestId'],
    errorResponses: ANY_KEY_ERRORS,
    responseExamples: { atm: 'ConnectionAtm' },
  },
  getWalletBalance: {
    method: 'POST',
    path: '/wallet/balance',
    operationId: 'getWalletBalance',
    tag: 'Wallet',
    summary: 'Identify a wallet and read its balance',
    description:
      'POST so the QR text never travels in a URL. Send the exact text the scanner decoded, or the NDEF URI read from\nthe ficha plus its chip UID. It spends nothing and does not use up a live code.\n\nA wallet outside the key\'s reach (another wallet group, or a home venue of another company) answers\n`404 wallet_not_found`, exactly like an unknown ficha (see Authentication). It does not tell whether a load\nwould be accepted: the venue\'s switches, pauses and the load limits are checked only by `POST /wallet/loads`.\n',
    scopes: ['wallet:balance'],
    money: false,
    successStatus: 200,
    response: WalletBalance,
    successHeaders: ['RequestId'],
    parameters: ['AcceptLanguage', 'XRequestId'],
    errorResponses: {
      '400': 'BadRequest',
      '401': 'Unauthorized',
      '403': 'ForbiddenScoped',
      '404': 'WalletNotFound',
      '409': 'WalletUnusable',
      '413': 'PayloadTooLarge',
      '422': 'WalletRefInvalid',
      '429': 'RateLimited',
      '503': 'TryLater',
      '5XX': 'ServerError',
    },
    responseExamples: { balance: 'Balance5000' },
    body: WalletBalanceRequest,
    bodyExamples: { ficha_nfc: 'BalanceRequestFicha', live_code: 'BalanceRequestLiveCode' },
  },
  createWalletLoad: {
    method: 'POST',
    path: '/wallet/loads',
    operationId: 'createWalletLoad',
    tag: 'Wallet',
    summary: "Load balance into a wallet",
    description:
      "The owner's call: `qr` + `amount` + `description` + the key, plus the `Idempotency-Key` header, the required\n`funding` and the optional `reference` and `device`. Synchronous: `201` means the balance is loaded.\n\n- `Idempotency-Key` = the ATM's own transaction id; `reference` = the same id, so the load can be found by it;\n  `device` = the ATM that took the money. See Idempotency for retries.\n- **Pilot:** `funding` must be `cash`. `card` answers `422 funding_not_allowed` until OxioPay enables it for the\n  connection. `transfer` and `bank_app` are for agent models and answer `422 funding_not_allowed` under\n  `venue_collects`.\n- A cash load needs the venue's balance and its cash top-ups switched on, as at its reception: otherwise\n  `409 method_disabled` with `method: wallet` or `method: cash_top_up`.\n- Limits (see `GET /me` → `limits.loads`): per operation, per wallet in 24 h for this connection, per wallet in\n  24 h for all partners, per wallet without a contact phone in 30 days for this partner, per connection per\n  night → `402 limit_exceeded` naming the limit. Cash into one wallet can never reach 1,000 € in 24 h counting\n  reception and every partner together → `402 cash_limit_reached`.\n- Loads into one wallet are checked one at a time: two loads that arrive together (two ATMs, or an ATM and\n  reception) are checked in turn against every limit, so no limit, the cash rule included, can be passed by\n  loading at the same moment. `balance_after` may include another movement made at that moment.\n- **Automatic pause** of new loads for the whole connection, until the owner resumes it (meanwhile this route\n  answers `403 scope_paused` and `GET /me` lists `wallet:load` in `paused_scopes`; reads and voids keep\n  working). Triggers: (1) 3 refusals by `limit_exceeded` with `limit: per_operation` within 10 minutes (the\n  same refused request repeated with the same Idempotency-Key and body counts once); (2) more than 30 new loads\n  (`201` without `Idempotent-Replayed`) in one minute; (3) 3 voids made by this connection through\n  `POST /wallet/loads/{id}/void` in one venue night (voids made by the venue from its panel do not count);\n  (4) calls with the key from 3 addresses outside its IP list within 24 hours. No other refusal counts. Check\n  the amount against `limits.loads.per_operation` before calling.\n- The answer carries `terms` (url, version and both summaries): print them on the ticket. With\n  `wallet:balance` it also carries `balance_after`.\n- A replay returns the stored original `201`. To know the current status of a load, read\n  `GET /wallet/loads/{id}`.\n",
    scopes: ['wallet:load'],
    money: true,
    successStatus: 201,
    response: WalletLoad,
    successHeaders: ['RequestId', 'IdempotentReplayed'],
    parameters: ['IdempotencyKey', 'AcceptLanguage', 'XRequestId'],
    errorResponses: {
      '400': 'LoadBadRequest',
      '401': 'Unauthorized',
      '402': 'LoadLimit',
      '403': 'ForbiddenMoney',
      '404': 'WalletNotFound',
      '409': 'LoadWalletUnusable',
      '413': 'PayloadTooLarge',
      '422': 'LoadInvalid',
      '423': 'VenuePaused',
      '429': 'RateLimited',
      '503': 'TryLater',
      '5XX': 'ServerError',
    },
    responseExamples: { created: 'LoadCreated' },
    body: WalletLoadRequest,
    bodyExamples: { cash_ficha: 'LoadRequestCash' },
  },
  getWalletLoad: {
    method: 'GET',
    path: '/wallet/loads/{id}',
    operationId: 'getWalletLoad',
    tag: 'Wallet',
    summary: "Read one of this connection's loads",
    description:
      "Returns the load with its current status. A load the venue voided from its panel also shows\n`status: \"voided\"` and `voided_at`. Another connection's load, or an id that is not one of this connection's\nloads, answers `404 load_not_found`. A pause of `wallet:load` does not stop this route.\n",
    scopes: ['wallet:load'],
    money: false,
    successStatus: 200,
    response: WalletLoad,
    successHeaders: ['RequestId'],
    parameters: ['LoadId', 'AcceptLanguage', 'XRequestId'],
    errorResponses: {
      '400': 'BadRequest',
      '401': 'Unauthorized',
      '403': 'ForbiddenRead',
      '404': 'LoadNotFound',
    '413': 'PayloadTooLarge',
    '429': 'RateLimited',
    '503': 'TryLater',
    '5XX': 'ServerError',
    },
    responseExamples: { succeeded: 'LoadRead', voided: 'LoadVoided' },
  },
  voidWalletLoad: {
    method: 'POST',
    path: '/wallet/loads/{id}/void',
    operationId: 'voidWalletLoad',
    tag: 'Wallet',
    summary: "Void one of this connection's loads (within 10 minutes)",
    description:
      "Removes the full amount of the load from the wallet. Only this connection's own loads, only until `void_until`\n(10 minutes after creation), and only while the wallet still holds the amount; the current state of the\nwallet, the ficha or the venue (blocked, lost, paused) does not stop it. Use it only when the money of the load\ndid not stay with the venue (for example the notes went back to the customer). While the ATM still holds the\nnotes, void first and give them back only after the void answers `200`. It is never a refund: the balance is\nnot returned in money. The customer gets a notice, and every void is shown to the owner at once.\n\nNaturally idempotent: voiding a voided load returns it again with `200`, at any time. After the window, or when\nthe balance was already spent, only the venue can correct it from its panel; such a void also shows on the load\n(`voided`, `voided_at`) and counts in `/statement` → `load_voids`. A pause of `wallet:load` does not stop\nvoids; the money freeze (`partner_api_frozen`) does.\n",
    scopes: ['wallet:load'],
    money: true,
    successStatus: 200,
    response: WalletLoad,
    successHeaders: ['RequestId'],
    parameters: ['LoadId', 'AcceptLanguage', 'XRequestId'],
    errorResponses: {
      '400': 'BadRequest',
      '401': 'Unauthorized',
      '403': 'ForbiddenVoid',
      '404': 'LoadNotFound',
      '409': 'VoidConflict',
      '413': 'PayloadTooLarge',
      '422': 'ValidationFailed',
      '429': 'RateLimited',
      '503': 'TryLater',
      '5XX': 'ServerError',
    },
    responseExamples: { voided: 'LoadVoided' },
    body: WalletLoadVoidRequest,
    bodyRequired: false,
    bodyExamples: { notes_returned: 'VoidRequest' },
  },
  listWalletOperations: {
    method: 'GET',
    path: '/wallet/operations',
    operationId: 'listWalletOperations',
    tag: 'Reconciliation',
    summary: "List this connection's own loads",
    description:
      "Give **either** `business_date` **or** `from` and `to` (at most 31 days). Both, neither, only one of `from`\nand `to`, or a `to` not after `from` → `422 validation_failed`, with `param` naming the first parameter at\nfault. Optional exact `reference`. Oldest first (by `created_at`, then `id`). Each load appears once, under\nits creation time, with its current status: a voided load, whether this connection or the venue voided it,\nshows `status: \"voided\"` and `voided_at`. A row appears when its transaction commits: read a night once it has\nended (after 08:05 Madrid) for a complete list. A pause of `wallet:load` does not stop this route.\n",
    scopes: ['wallet:load'],
    money: false,
    successStatus: 200,
    response: WalletLoadList,
    successHeaders: ['RequestId'],
    parameters: ['BusinessDate', 'From', 'To', 'ReferenceFilter', 'OperationType', 'Limit', 'Cursor', 'AcceptLanguage', 'XRequestId'],
    errorResponses: {
      '400': 'BadRequest',
      '401': 'Unauthorized',
      '403': 'ForbiddenRead',
      '404': 'ApiOff',
      '413': 'PayloadTooLarge',
      '422': 'RangeOrValidation',
      '429': 'RateLimited',
      '503': 'TryLater',
      '5XX': 'ServerError',
    },
    responseExamples: { by_reference: 'LoadListByReference' },
  },
  getStatement: {
    method: 'GET',
    path: '/statement',
    operationId: 'getStatement',
    tag: 'Reconciliation',
    summary: "Totals of this connection's loads and voids in a period",
    description:
      "The same numbers as the owner's \"Movimientos\" screen for this connection. Loads count at their creation time,\nvoids at the time of the void, whether this connection or the venue (from its panel) voided them. Under\n`venue_collects` the money of these loads is already the venue's; nobody owes anything through the API.\nSettlement between the ATM operator and the venue is outside the API. A pause of `wallet:load` does not stop\nthis route.\n\nIn this pilot the statement holds only the loads block; blocks for other scopes come with those features.\n",
    scopes: ['wallet:load'],
    money: false,
    successStatus: 200,
    response: Statement,
    successHeaders: ['RequestId'],
    parameters: ['StatementFrom', 'StatementTo', 'AcceptLanguage', 'XRequestId'],
    errorResponses: {
      '400': 'BadRequest',
      '401': 'Unauthorized',
      '403': 'ForbiddenRead',
      '404': 'ApiOff',
      '413': 'PayloadTooLarge',
      '422': 'StatementRangeOrValidation',
      '429': 'RateLimited',
      '503': 'TryLater',
      '5XX': 'ServerError',
    },
    responseExamples: { night: 'StatementNight' },
  },
  getOpenApi: {
    method: 'GET',
    path: '/openapi.json',
    operationId: 'getOpenApi',
    tag: 'Reference',
    summary: 'This OpenAPI 3.1 document',
    description: 'Public, no key needed. Answers 404 while the partner API is switched off.',
    scopes: [],
    money: false,
    successStatus: 200,
    // Pasa entero (z.object lo dejaría en {}); se publica como { type: 'object' }.
    response: z.looseObject({}),
    successHeaders: ['RequestId'],
    parameters: [],
    errorResponses: { '404': 'ApiOff', '429': 'RateLimited', '5XX': 'ServerError' },
  },
} as const satisfies Record<string, PartnerRouteDef>;

export type PartnerRouteName = keyof typeof PARTNER_ROUTES;

/** La descripción de la respuesta buena de cada ruta (la del contrato). */
export const PARTNER_SUCCESS_DESCRIPTIONS: Readonly<Record<PartnerRouteName, string>> = {
  getConnection: 'The connection.',
  getWalletBalance: 'The balance of the identified wallet.',
  createWalletLoad: 'The balance is loaded (or this is the replay of the original answer).',
  getWalletLoad: 'The load.',
  voidWalletLoad: 'The load, now voided.',
  listWalletOperations: 'A page of loads.',
  getStatement: 'The totals.',
  getOpenApi: 'The OpenAPI 3.1 document of the partner API.',
};
