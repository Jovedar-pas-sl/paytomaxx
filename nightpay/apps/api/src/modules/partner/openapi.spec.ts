import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PARTNER_CONNECTION_EXAMPLE,
  PartnerConnectionSchema,
  PartnerProblemSchema,
  WalletBalance,
  WalletBalanceRequest,
  buildPartnerOpenApi,
  partnerErrorsMarkdown,
} from '@nightpay/contracts';

/**
 * El documento OpenAPI de la API de socios: el del repositorio es el que se
 * genera, no tiene $ref sin destino y, en las rutas que ya existen, dice lo
 * mismo que el contrato del piloto (docs/partner-api/pilot), que manda.
 */

type Json = Record<string, unknown>;
const DOCS = join(__dirname, '../../../../../docs/partner-api');
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Json;
const generated = buildPartnerOpenApi();
const pilot = readJson(join(DOCS, 'pilot/openapi-piloto.json'));

/** Rutas del contrato que llegan con su entrega (al hacerlas, se quitan de aquí). */
const PILOT_PENDING = [
  'POST /wallet/loads',
  'GET /wallet/loads/{id}',
  'POST /wallet/loads/{id}/void',
  'GET /wallet/operations',
  'GET /statement',
  'POST /test/live-codes',
  'POST /test/fixtures/reset',
];

/** Palabras que solo describen (no cambian qué vale): fuera al comparar. */
const ANNOTATIONS = new Set(['description', 'summary', 'example', 'examples', 'title', 'x-decided-in-contract', 'x-demo-only', 'deprecated']);

function resolve(doc: Json, ref: string): unknown {
  return ref
    .replace(/^#\//, '')
    .split('/')
    .reduce<unknown>((node, key) => (node as Json | undefined)?.[key], doc);
}

/** Con las $ref resueltas, sin anotaciones y con `required`/`enum` ordenados. */
function normalize(doc: Json, value: unknown, inProperties = false, depth = 0): unknown {
  if (depth > 60) throw new Error('demasiado hondo (¿un ciclo?)');
  if (Array.isArray(value)) return value.map((v) => normalize(doc, v, false, depth + 1));
  if (typeof value !== 'object' || value === null) return value;
  const obj = value as Json;
  if (!inProperties && typeof obj.$ref === 'string') return normalize(doc, resolve(doc, obj.$ref), false, depth + 1);
  const out: Json = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!inProperties && ANNOTATIONS.has(k)) continue;
    if (!inProperties && (k === 'required' || k === 'enum') && Array.isArray(v)) {
      out[k] = [...v].sort();
      continue;
    }
    out[k] = normalize(doc, v, !inProperties && k === 'properties', depth + 1);
  }
  return out;
}

function operations(doc: Json): Map<string, Json> {
  const out = new Map<string, Json>();
  for (const [path, item] of Object.entries(doc.paths as Json)) {
    for (const [method, op] of Object.entries(item as Json)) out.set(`${method.toUpperCase()} ${path}`, op as Json);
  }
  return out;
}

/** Lo que tiene que coincidir de una operación. */
function contractOf(doc: Json, op: Json): Json {
  return {
    responses: normalize(doc, op.responses),
    requestBody: normalize(doc, op.requestBody ?? null),
    parameters: normalize(doc, op.parameters ?? []),
    'x-required-scope': op['x-required-scope'],
    security: op.security ?? doc.security,
  };
}

function refsOf(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => refsOf(v, out));
  else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      if (k === '$ref' && typeof v === 'string') out.push(v);
      else refsOf(v, out);
    }
  }
  return out;
}

describe('docs/partner-api/openapi.json', () => {
  it('es el que se genera (pnpm --filter @nightpay/api partner:docs)', () => {
    expect(readJson(join(DOCS, 'openapi.json'))).toEqual(generated);
  });

  it('errors.md es el catálogo de errors.ts', () => {
    expect(readFileSync(join(DOCS, 'errors.md'), 'utf8').replace(/\r\n/g, '\n')).toBe(partnerErrorsMarkdown());
  });

  it('ningún $ref sin destino', () => {
    const missing = refsOf(generated).filter((ref) => resolve(generated, ref) === undefined);
    expect(missing).toEqual([]);
  });

  it('cada ejemplo pasa su propio esquema (la conexión, el saldo, el cuerpo de la petición o un problema)', () => {
    expect(PartnerConnectionSchema.parse(PARTNER_CONNECTION_EXAMPLE.value)).toEqual(PARTNER_CONNECTION_EXAMPLE.value);
    const schemaOf = (name: string, value: Json) =>
      value.object === 'connection'
        ? PartnerConnectionSchema
        : value.object === 'wallet_balance'
          ? WalletBalance
          : name.startsWith('BalanceRequest')
            ? WalletBalanceRequest
            : PartnerProblemSchema;
    const examples = Object.entries((generated.components as Json).examples as Record<string, Json>);
    expect(examples.map(([n]) => n)).toEqual(expect.arrayContaining(['Balance5000', 'BalanceRequestFicha', 'BalanceRequestLiveCode', 'ProblemPrivateLink']));
    for (const [name, ex] of examples) {
      const value = ex.value as Json;
      expect(schemaOf(name, value).safeParse(value).success, name).toBe(true);
    }
  });

  it('los ejemplos de /wallet/balance son los del contrato', () => {
    const ours = (generated.components as Json).examples as Record<string, Json>;
    const theirs = (pilot.components as Json).examples as Record<string, Json>;
    for (const name of ['Balance5000', 'BalanceRequestFicha', 'BalanceRequestLiveCode', 'ProblemWalletNotFound', 'ProblemFichaCopy', 'ProblemPrivateLink', 'ProblemLiveCodeInvalid']) {
      expect(ours[name], name).toEqual(theirs[name]);
    }
  });
});

describe('contrato del piloto (docs/partner-api/pilot/openapi-piloto.json)', () => {
  const ours = operations(generated);
  const theirs = operations(pilot);

  it('cada ruta del contrato está hecha o en PILOT_PENDING, y las pendientes no están hechas', () => {
    expect([...theirs.keys()].filter((k) => !ours.has(k) && !PILOT_PENDING.includes(k))).toEqual([]);
    expect(PILOT_PENDING.filter((k) => ours.has(k))).toEqual([]);
    expect(PILOT_PENDING.filter((k) => !theirs.has(k))).toEqual([]);
  });

  it('ninguna ruta nuestra que no esté en el contrato', () => {
    expect([...ours.keys()].filter((k) => !theirs.has(k))).toEqual([]);
  });

  it.each([...operations(generated).keys()])('%s: mismas respuestas, esquemas, x-required-scope, parámetros y seguridad', (key) => {
    expect(contractOf(generated, ours.get(key)!)).toEqual(contractOf(pilot, theirs.get(key)!));
  });

  it('mismos info, servers, tags y esquema de seguridad', () => {
    expect(generated.info).toEqual(pilot.info);
    expect(generated.servers).toEqual(pilot.servers);
    expect(generated.tags).toEqual(pilot.tags);
    expect((generated.components as Json).securitySchemes).toEqual((pilot.components as Json).securitySchemes);
  });
});
