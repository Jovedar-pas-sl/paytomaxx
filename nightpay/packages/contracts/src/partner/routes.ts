import { z } from 'zod';
import type { PartnerScope } from './common';
import { PartnerConnectionSchema } from './connection';
import type { PartnerErrorResponseName } from './errors';

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
  readonly bodyExamples?: Readonly<Record<string, PartnerExampleName>>;
}

/** Ejemplos de respuestas buenas (components.examples). */
export type PartnerExampleName = 'ConnectionAtm';

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
  getOpenApi: 'The OpenAPI 3.1 document of the partner API.',
};
