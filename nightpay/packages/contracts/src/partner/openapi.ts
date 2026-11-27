import { z } from 'zod';
import { partnerSchemas } from './common';
import { PartnerScopeListSchema } from './connection';
import {
  PARTNER_ERRORS,
  PARTNER_ERROR_RESPONSES,
  PARTNER_EXAMPLE_REQUEST_ID,
  PARTNER_PROBLEM_EXAMPLES,
  PartnerProblemSchema,
  partnerProblemType,
  type PartnerErrorResponseName,
  type PartnerProblemExampleDef,
  type PartnerProblemExampleName,
} from './errors';
import {
  PARTNER_CONNECTION_EXAMPLE,
  PARTNER_OPENAPI_INFO,
  PARTNER_LOAD_EXAMPLES,
  PARTNER_WALLET_EXAMPLES,
  PARTNER_OPENAPI_SERVERS,
  PARTNER_OPENAPI_TAGS,
  PARTNER_SECURITY_SCHEMES,
} from './openapi-contract';
import {
  PARTNER_HEADERS,
  PARTNER_PARAMETERS,
  PARTNER_ROUTES,
  PARTNER_SUCCESS_DESCRIPTIONS,
  type PartnerExampleName,
  type PartnerHeaderName,
  type PartnerParameterName,
  type PartnerRouteDef,
} from './routes';

// El documento OpenAPI 3.1 de la API de socios, de la tabla de rutas y de los
// esquemas zod (z.toJSONSchema, sin dependencias nuevas). Puro: lo sirve
// GET /v1/partner/openapi.json y lo escribe apps/api/scripts/partner-openapi.ts
// en docs/partner-api/openapi.json. Del contrato copia info, servers, tags y
// el esquema de seguridad, y publica solo lo que alcanzan las rutas hechas.

type Json = Record<string, unknown>;
type Io = 'input' | 'output';

const SCHEMAS = '#/components/schemas/';
const HEADER_NAMES: Readonly<Record<PartnerHeaderName, string>> = {
  RequestId: 'Request-Id',
  RetryAfter: 'Retry-After',
  IdempotentReplayed: 'Idempotent-Replayed',
};
const EXAMPLES: Readonly<Record<PartnerExampleName, Json>> = {
  ConnectionAtm: PARTNER_CONNECTION_EXAMPLE as unknown as Json,
  ...(PARTNER_WALLET_EXAMPLES as unknown as Record<string, Json>),
  ...(PARTNER_LOAD_EXAMPLES as unknown as Record<string, Json>),
} as Record<PartnerExampleName, Json>;

const isEmptyObject = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0;

/**
 * Lo que z.toJSONSchema escribe distinto del contrato, arreglado aquí (nunca
 * en la prueba): fuera `additionalProperties: false` de las respuestas (lo de
 * más se ignora, nunca se rechaza), `{}` vacíos, el `pattern` de date-time y
 * los topes de entero seguro; `anyOf [X, null]` simple como `type: [X, 'null']`;
 * un literal entero es `integer`; las listas de permisos, `uniqueItems`.
 */
function tidy(zodSchema: unknown, json: Json, io: Io): void {
  if (io === 'output' && json.additionalProperties === false) delete json.additionalProperties;
  if (isEmptyObject(json.additionalProperties)) delete json.additionalProperties;
  if (isEmptyObject(json.properties)) delete json.properties;
  if (json.format === 'date-time') delete json.pattern;
  if (json.minimum === -Number.MAX_SAFE_INTEGER) delete json.minimum;
  if (json.maximum === Number.MAX_SAFE_INTEGER) delete json.maximum;
  if (json.type === 'number' && Number.isInteger(json.const)) json.type = 'integer';
  if (zodSchema === PartnerScopeListSchema) json.uniqueItems = true;
  collapseNullable(json);
}

function collapseNullable(json: Json): void {
  const any = json.anyOf;
  if (!Array.isArray(any) || any.length !== 2) return;
  const nullAt = any.findIndex((s: Json) => s?.type === 'null' && Object.keys(s).length === 1);
  const other = any[1 - nullAt] as Json | undefined;
  if (nullAt < 0 || typeof other?.type !== 'string' || '$ref' in other) return;
  delete json.anyOf;
  Object.assign(json, { ...other, ...json, type: [other.type, 'null'] });
}

function rewriteRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteRefs);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      k === '$ref' && typeof v === 'string' ? v.replace('#/$defs/', SCHEMAS) : rewriteRefs(v),
    ]),
  );
}

/** El esquema publicado; los que tienen nombre (`id`) van a `defs` y aquí queda su $ref. */
function toSchema(schema: z.ZodType, io: Io, defs: Map<string, Json>): Json {
  const json = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    unrepresentable: 'throw',
    metadata: partnerSchemas,
    override: (ctx) => tidy(ctx.zodSchema, ctx.jsonSchema as Json, io),
  }) as Json;
  const { $schema: _schema, $id: _id, $defs, ...root } = json;
  for (const [id, def] of Object.entries(($defs ?? {}) as Record<string, Json>)) {
    const clean = rewriteRefs(def) as Json;
    const known = defs.get(id);
    if (known && JSON.stringify(known) !== JSON.stringify(clean)) throw new Error(`Esquema ${id} distinto en entrada y salida`);
    defs.set(id, clean);
  }
  return rewriteRefs(root) as Json;
}

interface Used {
  parameters: Set<PartnerParameterName>;
  headers: Set<PartnerHeaderName>;
  responses: Set<PartnerErrorResponseName>;
  examples: Set<PartnerExampleName | PartnerProblemExampleName>;
}

const ref = (kind: string, name: string) => ({ $ref: `#/components/${kind}/${name}` });

function headersOf(names: readonly PartnerHeaderName[], used: Used): Json {
  for (const h of names) used.headers.add(h);
  return Object.fromEntries(names.map((h) => [HEADER_NAMES[h], ref('headers', h)]));
}

function examplesOf(names: Readonly<Record<string, PartnerExampleName>> | undefined, used: Used): Json {
  if (!names) return {};
  for (const e of Object.values(names)) used.examples.add(e);
  return { examples: Object.fromEntries(Object.entries(names).map(([k, e]) => [k, ref('examples', e)])) };
}

function operation(name: string, def: PartnerRouteDef, defs: Map<string, Json>, used: Used): Json {
  const success: Json = {
    description: PARTNER_SUCCESS_DESCRIPTIONS[name as keyof typeof PARTNER_SUCCESS_DESCRIPTIONS] ?? 'OK',
    headers: headersOf(def.successHeaders, used),
    ...(def.successStatus === 204
      ? {}
      : { content: { 'application/json': { schema: toSchema(def.response, 'output', defs), ...examplesOf(def.responseExamples, used) } } }),
  };
  const errors = Object.entries(def.errorResponses).map(([status, response]) => {
    used.responses.add(response);
    return [status, ref('responses', response)] as const;
  });
  for (const p of def.parameters) used.parameters.add(p);
  return {
    operationId: def.operationId,
    tags: [def.tag],
    summary: def.summary,
    description: def.description,
    ...(def.scopes.length === 0 ? { security: [] } : {}),
    'x-required-scope': [...def.scopes],
    ...(def.parameters.length > 0 ? { parameters: def.parameters.map((p) => ref('parameters', p)) } : {}),
    ...(def.body
      ? {
          requestBody: {
            required: def.bodyRequired ?? true,
            content: { 'application/json': { schema: toSchema(def.body, 'input', defs), ...examplesOf(def.bodyExamples, used) } },
          },
        }
      : {}),
    responses: { [String(def.successStatus)]: success, ...Object.fromEntries(errors) },
  };
}

function errorResponse(name: PartnerErrorResponseName, used: Used): Json {
  const def: { description: string; codes: readonly string[]; examples?: readonly PartnerProblemExampleName[]; retryAfter?: boolean } =
    PARTNER_ERROR_RESPONSES[name];
  const exampleKey = (e: PartnerProblemExampleName) => {
    const ex: PartnerProblemExampleDef = PARTNER_PROBLEM_EXAMPLES[e];
    return ex.key ?? ex.code;
  };
  for (const e of def.examples ?? []) used.examples.add(e);
  return {
    description: def.description,
    headers: headersOf(def.retryAfter ? ['RequestId', 'RetryAfter'] : ['RequestId'], used),
    content: {
      'application/problem+json': {
        schema: { allOf: [{ $ref: `${SCHEMAS}Problem` }, { type: 'object', properties: { code: { enum: [...def.codes] } } }] },
        ...(def.examples?.length
          ? { examples: Object.fromEntries(def.examples.map((e) => [exampleKey(e), ref('examples', e)])) }
          : {}),
      },
    },
  };
}

function problemExample(name: PartnerProblemExampleName): Json {
  const ex: PartnerProblemExampleDef = PARTNER_PROBLEM_EXAMPLES[name];
  const err = PARTNER_ERRORS[ex.code];
  return {
    summary: ex.summary,
    value: {
      type: partnerProblemType(ex.code),
      title: err.title,
      status: err.status,
      code: ex.code,
      detail: err.en,
      ...ex.extra,
      request_id: PARTNER_EXAMPLE_REQUEST_ID,
    },
  };
}

const sortedEntries = <T>(map: Map<string, T> | Set<string>, build: (name: string) => T) =>
  Object.fromEntries([...map.keys()].sort().map((k) => [k, build(k)]));

/** El documento entero (objetos nuevos en cada llamada). */
export function buildPartnerOpenApi(routes: Readonly<Record<string, PartnerRouteDef>> = PARTNER_ROUTES): Json {
  const defs = new Map<string, Json>();
  const used: Used = { parameters: new Set(), headers: new Set(), responses: new Set(), examples: new Set() };
  const paths: Record<string, Json> = {};
  for (const [name, def] of Object.entries(routes)) {
    paths[def.path] = { ...paths[def.path], [def.method.toLowerCase()]: operation(name, def, defs, used) };
  }
  const responses = sortedEntries(used.responses, (r) => errorResponse(r as PartnerErrorResponseName, used));
  if (used.responses.size > 0) toSchema(PartnerProblemSchema, 'output', defs);
  const doc = {
    openapi: '3.1.0',
    info: PARTNER_OPENAPI_INFO,
    servers: PARTNER_OPENAPI_SERVERS,
    security: [{ bearerAuth: [] }],
    tags: PARTNER_OPENAPI_TAGS,
    paths,
    components: {
      securitySchemes: PARTNER_SECURITY_SCHEMES,
      parameters: sortedEntries(used.parameters, (p) => PARTNER_PARAMETERS[p as PartnerParameterName]),
      headers: sortedEntries(used.headers, (h) => PARTNER_HEADERS[h as PartnerHeaderName]),
      responses,
      schemas: sortedEntries(defs, (id) => defs.get(id)!),
      examples: sortedEntries(used.examples, (e) =>
        e in EXAMPLES ? EXAMPLES[e as PartnerExampleName] : problemExample(e as PartnerProblemExampleName),
      ),
    },
  };
  return JSON.parse(JSON.stringify(doc)) as Json;
}

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

/** docs/partner-api/errors.md: el catálogo en inglés y en español. */
export function partnerErrorsMarkdown(): string {
  const rows = Object.entries(PARTNER_ERRORS).map(
    ([code, e]) => `| \`${code}\` | ${e.status} | ${cell(e.title)} | ${cell(e.en)} | ${cell(e.es)} |`,
  );
  return [
    '# Errores de la API de socios / Partner API errors',
    '',
    '<!-- generated: pnpm --filter @nightpay/api partner:docs, de packages/contracts/src/partner/errors.ts. No se edita a mano. -->',
    '',
    'Decide por `code`, nunca por `title` ni `detail`. `detail` sale en inglés o, con `Accept-Language: es`, en español.',
    'Branch on `code`, never on `title` or `detail`. `detail` is English, or Spanish with `Accept-Language: es`.',
    '',
    '| code | HTTP | title | detail (en) | detail (es) |',
    '|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}
