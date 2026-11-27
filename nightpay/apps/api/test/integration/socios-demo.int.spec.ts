// Integración (Postgres y Redis de verdad): la API de socios, PR 8 parte A, la
// demo en modo prueba. Las ayudas `POST /v1/partner/test/live-codes` y
// `POST /v1/partner/test/fixtures/reset` con las fichas de la semilla
// (seedPartnerDemo): solo existen con PARTNER_API_MODE=test y
// PARTNER_TEST_HELPERS=1 (la prueba pone y quita la variable); el reinicio
// escribe solo las 9 fichas y sus saldos nuevos, de una en una y sin borrar; y
// ni el código, ni el enlace, ni el UID llegan al log, Sentry o el registro.
// Montaje: test/support/socios.ts. Ver README.md.
import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { DEMO_FIXTURES, FIXTURES, TestLiveCode, type FixtureName as Fixture } from '@nightpay/contracts';
import * as sentry from '../../src/common/observability/sentry';
import { DEMO_VENUES, resetDemoFixtures, seedPartnerDemo } from '../../src/modules/partner/test-helpers/partner-demo-fixtures';
import { WalletLiveCodeService } from '../../src/modules/wallets/wallet-live-code.service';
import { clearRedis, connection, ficha, mountSocios, newKey, partner, wallet, type Socios, type TestConnection } from '../support/socios';

vi.mock('../../src/common/observability/sentry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/common/observability/sentry')>()),
  reportError: vi.fn(),
}));

const HOST = 'https://demo-operator.oxiopay.example';
const UID = '04A1B2C3D4E5F6';
const fichaQr = (f: Fixture) => `${HOST}/?ficha=${DEMO_FIXTURES[f].token}`;
const codeOf = (res: { json: () => unknown }) => (res.json() as { code?: string }).code;

let s: Socios;
let venues: Record<keyof typeof DEMO_VENUES, { id: string; businessId: string | null }>;
/** «Cajeros Demo» en Local Demo Centro (los dos permisos). */
let CD: TestConnection;
/** Solo wallet:balance, en Local Demo Centro. */
let BAL: TestConnection;
/** Una clave de Local Demo Otro Grupo (misma sociedad, otro grupo). */
let OG: TestConnection;

function setHelpers(on: boolean, mode: 'test' | 'live' = 'test') {
  vi.stubEnv('PARTNER_API_ENABLED', 'true');
  vi.stubEnv('PARTNER_API_MODE', mode);
  vi.stubEnv('EDITION', 'club');
  if (on) vi.stubEnv('PARTNER_TEST_HELPERS', '1');
  else delete process.env.PARTNER_TEST_HELPERS;
}

function post(app: Socios['app'], url: string, conn: TestConnection | null, o: { body?: unknown; headers?: Record<string, string> } = {}) {
  return app.inject({
    method: 'POST',
    url: `/v1/partner${url}`,
    headers: { ...(conn ? { authorization: `Bearer ${conn.key}` } : {}), ...o.headers },
    ...(o.body === undefined ? {} : { payload: o.body as object }),
  });
}

const liveCode = async (f: Fixture, conn: TestConnection = CD) => {
  const res = await post(s.app, '/test/live-codes', conn, { body: { fixture: f } });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { code: string }).code;
};
const reset = (conn: TestConnection = CD, o: { body?: unknown; headers?: Record<string, string> } = {}) => post(s.app, '/test/fixtures/reset', conn, o);
const balance = (qr: string, nfcUid?: string, conn: TestConnection = CD) =>
  post(s.app, '/wallet/balance', conn, { body: { qr, ...(nfcUid ? { nfc_uid: nfcUid } : {}) } });
function load(conn: TestConnection, qr: string, amount: number, o: { nfcUid?: string; reference?: string } = {}) {
  const key = o.reference ?? newKey();
  return s.app.inject({
    method: 'POST',
    url: '/v1/partner/wallet/loads',
    headers: { authorization: `Bearer ${conn.key}`, 'idempotency-key': key },
    payload: { qr, amount, description: 'Recarga en cajero 0042', funding: 'cash', reference: key, ...(o.nfcUid ? { nfc_uid: o.nfcUid } : {}) },
  });
}

/** Lo que tiene cada ficha ahora: su saldo vivo y su estado. */
const fixtureRows = () =>
  s.sys(async (tx) => {
    const cards = await tx.walletCard.findMany({
      where: { token: { in: FIXTURES.map((f) => DEMO_FIXTURES[f].token) } },
      include: { wallet: true },
    });
    return new Map(cards.map((c) => [c.token, c]));
  });

const maxAuditId = async () => (await s.sys((tx) => tx.auditEvent.aggregate({ _max: { id: true } })))._max.id ?? 0n;
const auditsSince = (since: bigint) => s.sys((tx) => tx.auditEvent.findMany({ where: { id: { gt: since } }, orderBy: { id: 'asc' } }));

beforeAll(async () => {
  setHelpers(true);
  s = await mountSocios();
  await s.sys((tx) => seedPartnerDemo(tx, { carga: 3 }));
  const rows = await s.sys((tx) => tx.venue.findMany({ where: { slug: { in: Object.values(DEMO_VENUES).map((v) => v.slug) } } }));
  const bySlug = new Map(rows.map((v) => [v.slug, { id: v.id, businessId: v.businessId }]));
  venues = {
    centro: bySlug.get('demo-centro')!,
    otraSociedad: bySlug.get('demo-otra-sociedad')!,
    otroGrupo: bySlug.get('demo-otro-grupo')!,
  };
  const P = await partner(s, { name: 'Cajeros Demo' });
  CD = await connection(s, { venueId: venues.centro.id, businessId: venues.centro.businessId!, partnerId: P });
  BAL = await connection(s, { venueId: venues.centro.id, businessId: venues.centro.businessId!, partnerId: await partner(s) }, { scopes: ['wallet:balance'] });
  OG = await connection(s, { venueId: venues.otroGrupo.id, businessId: venues.otroGrupo.businessId!, partnerId: P });
});

beforeEach(async () => {
  setHelpers(true);
  await clearRedis(s.redis);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await s?.close();
  vi.unstubAllEnvs();
  delete process.env.PARTNER_TEST_HELPERS;
});

describe('1. sin PARTNER_TEST_HELPERS las ayudas no existen', () => {
  it('en test y en live: las dos rutas dan el 404 not_found de una ruta inexistente (montadas darían 401)', async () => {
    for (const mode of ['test', 'live'] as const) {
      setHelpers(false, mode);
      const bare = await mountSocios();
      try {
        const missing = await post(bare.app, '/test/no-existe', null, { body: { fixture: 'active' } });
        const shape = (r: typeof missing) => ({ status: r.statusCode, type: r.headers['content-type'], code: codeOf(r), title: (r.json() as { title?: string }).title });
        expect(shape(missing)).toMatchObject({ status: 404, code: 'not_found' });
        for (const [url, body] of [['/test/live-codes', { fixture: 'active' }], ['/test/fixtures/reset', undefined]] as const) {
          const res = await post(bare.app, url, CD, { body });
          expect(shape(res), `${mode} ${url}`).toEqual(shape(missing));
          const anon = await post(bare.app, url, null, { body });
          expect(shape(anon), `${mode} ${url} sin clave`).toEqual(shape(missing));
        }
      } finally {
        await bare.close();
      }
    }
    // Montadas (la demo), sin clave: 401 (así se distingue en «Encender», paso 3).
    setHelpers(true);
    expect((await post(s.app, '/test/fixtures/reset', null)).statusCode).toBe(401);
    expect(codeOf(await post(s.app, '/test/live-codes', null, { body: { fixture: 'active' } }))).toBe('invalid_api_key');
  });

  it('montadas pero con la variable quitada después: el guard las niega con 404 (tercera barrera)', async () => {
    delete process.env.PARTNER_TEST_HELPERS;
    const res = await post(s.app, '/test/live-codes', CD, { body: { fixture: 'active' } });
    expect([res.statusCode, codeOf(res)]).toEqual([404, 'not_found']);
    expect([(await reset()).statusCode]).toEqual([404]);
  });
});

describe('2. la semilla, GET /me y cada ficha', () => {
  it('la semilla dos veces da los mismos recuentos; GET /me, el emisor del contrato', async () => {
    const first = await s.sys((tx) => seedPartnerDemo(tx, { carga: 3 }));
    const second = await s.sys((tx) => seedPartnerDemo(tx, { carga: 3 }));
    // `carga` cuenta todas las demo-carga-… de la base (una semilla anterior con --carga 300 deja 300).
    expect(first).toMatchObject({ sociedades: 2, locales: 3, fichas: 9 });
    expect(first.carga).toBeGreaterThanOrEqual(3);
    expect(second).toEqual(first);
    const cargas = await s.sys((tx) => tx.walletCard.findMany({ where: { token: { startsWith: 'demo-carga-' } }, include: { wallet: true } }));
    expect(cargas).toHaveLength(first.carga);
    expect(cargas.map((c) => c.token)).toEqual(expect.arrayContaining(['demo-carga-000001', 'demo-carga-000002', 'demo-carga-000003']));
    expect(cargas.every((c) => c.status === 'ISSUED' && c.venueId === venues.centro.id && c.wallet?.status === 'DEPLETED')).toBe(true);
    const me = await s.app.inject({ method: 'GET', url: '/v1/partner/me', headers: { authorization: `Bearer ${CD.key}` } });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json()).toMatchObject({ issuer: { legal_name: 'Empresa Demo S.L.', tax_id: 'B00000000' }, venue_name: 'Local Demo Centro', livemode: false });
  });

  it('reinicio → 204 sin cuerpo (con no-store y Request-Id); con cuerpo, 400 invalid_request', async () => {
    const ok = await reset(CD, { headers: { 'x-request-id': 'demo-reset-1' } });
    expect(ok.statusCode, ok.body).toBe(204);
    expect(ok.body).toBe('');
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.headers['request-id']).toBe('demo-reset-1');
    for (const body of [{}, { fixture: 'active' }]) {
      const bad = await reset(CD, { body });
      expect([bad.statusCode, codeOf(bad)], JSON.stringify(body)).toEqual([400, 'invalid_request']);
    }
  });

  it('cada ficha, por enlace (con su UID) y por código, responde lo que dice su tabla', async () => {
    expect((await reset()).statusCode).toBe(204);
    const byLink: Record<Fixture, [number, string | number]> = {
      active: [200, 5000],
      empty: [200, 0],
      ficha_uid: [200, 5000],
      blocked: [409, 'wallet_blocked'],
      closed: [409, 'wallet_closed'],
      lost_ficha: [409, 'ficha_lost'],
      ficha_blocked: [409, 'ficha_blocked'],
      other_group: [404, 'wallet_not_found'],
      other_company: [404, 'wallet_not_found'],
    };
    const byCode: Record<Fixture, [number, string | number]> = { ...byLink, lost_ficha: [200, 5000], ficha_blocked: [200, 5000] };
    const answer = (res: Awaited<ReturnType<typeof balance>>): [number, string | number] =>
      res.statusCode === 200 ? [200, (res.json() as { available: number }).available] : [res.statusCode, codeOf(res)!];
    for (const f of FIXTURES) {
      expect(answer(await balance(fichaQr(f), f === 'ficha_uid' ? UID : undefined)), `${f} por enlace`).toEqual(byLink[f]);
      expect(answer(await balance(await liveCode(f))), `${f} por código`).toEqual(byCode[f]);
    }
    expect(answer(await balance(fichaQr('ficha_uid'), '04:a1:b2:c3:d4:e5:f6'))).toEqual([200, 5000]);
    expect(answer(await balance(fichaQr('ficha_uid'), '04BBBBBBBBBBBB'))).toEqual([409, 'ficha_copy_suspected']);
    expect(answer(await balance(fichaQr('ficha_uid')))).toEqual([200, 5000]);
    // Ninguna ficha tiene teléfono.
    const rows = await fixtureRows();
    expect([...rows.values()].every((c) => c.wallet?.contactPhone === null)).toBe(true);
    expect(rows.get(DEMO_FIXTURES.ficha_uid.token)!.uid).toBe(UID);
  });
});

describe('3. el reinicio: saldo nuevo, mismas fichas, solo lo suyo', () => {
  it('20 € en active y reinicio: 5.000, mismo token y UID, saldo nuevo; la carga sigue en /wallet/operations y /statement', async () => {
    expect((await reset()).statusCode).toBe(204);
    const before = await fixtureRows();
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date(Date.now() + 3_600_000).toISOString();
    const ref = newKey('DEMO');
    const loaded = await load(CD, fichaQr('active'), 2000, { reference: ref });
    expect(loaded.statusCode, loaded.body).toBe(201);
    expect((await balance(fichaQr('active'))).json()).toMatchObject({ available: 7000 });
    const statementBefore = (await s.app.inject({ method: 'GET', url: `/v1/partner/statement?from=${from}&to=${to}`, headers: { authorization: `Bearer ${CD.key}` } })).json() as { loads: { count: number; amount: number } };
    expect((await reset()).statusCode).toBe(204);
    const after = await fixtureRows();
    for (const f of FIXTURES) {
      const [b, a] = [before.get(DEMO_FIXTURES[f].token)!, after.get(DEMO_FIXTURES[f].token)!];
      expect(a.id, f).toBe(b.id);
      expect(a.uid, f).toBe(DEMO_FIXTURES[f].uid);
      expect(a.walletId, f).not.toBe(b.walletId);
      expect(a.wallet!.balanceCents, f).toBe(DEMO_FIXTURES[f].balanceCents);
    }
    expect((await balance(fichaQr('active'))).json()).toMatchObject({ available: 5000 });
    // El saldo viejo sigue con su carga (nunca se borra).
    const old = await s.sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id: before.get(DEMO_FIXTURES.active.token)!.walletId! } }));
    expect(old.balanceCents).toBe(7000);
    const ops = await s.app.inject({ method: 'GET', url: `/v1/partner/wallet/operations?from=${from}&to=${to}&reference=${ref}`, headers: { authorization: `Bearer ${CD.key}` } });
    expect(ops.statusCode, ops.body).toBe(200);
    expect((ops.json() as { data: Array<{ reference: string; status: string }> }).data).toMatchObject([{ reference: ref, status: 'succeeded' }]);
    const statement = await s.app.inject({ method: 'GET', url: `/v1/partner/statement?from=${from}&to=${to}`, headers: { authorization: `Bearer ${CD.key}` } });
    expect((statement.json() as { loads: { count: number; amount: number } }).loads).toEqual(statementBefore.loads);
    expect(statementBefore.loads.count).toBeGreaterThanOrEqual(1);
  });

  it('wallet_24h vuelve a empezar y connection_night las sigue contando', async () => {
    const night = await connection(s, { venueId: venues.centro.id, businessId: venues.centro.businessId!, partnerId: await partner(s) }, { loadNightMaxCents: 65000 });
    expect((await reset()).statusCode).toBe(204);
    expect((await load(night, fichaQr('empty'), 30000)).statusCode).toBe(201);
    expect((await load(night, fichaQr('empty'), 30000)).statusCode).toBe(201);
    const over = await load(night, fichaQr('empty'), 1);
    expect([over.statusCode, codeOf(over), (over.json() as { limit?: string }).limit]).toEqual([402, 'limit_exceeded', 'wallet_24h']);
    expect((await reset()).statusCode).toBe(204);
    const nightOver = await load(night, fichaQr('empty'), 30000);
    expect([nightOver.statusCode, (nightOver.json() as { limit?: string }).limit]).toEqual([402, 'connection_night']);
    expect((await load(night, fichaQr('empty'), 5000)).statusCode).toBe(201);
  });

  it('un código anterior al reinicio → 422 live_code_invalid', async () => {
    const code = await liveCode('active');
    expect((await balance(code)).statusCode).toBe(200);
    expect((await reset()).statusCode).toBe(204);
    const res = await balance(code);
    expect([res.statusCode, codeOf(res)]).toEqual([422, 'live_code_invalid']);
    expect((await balance(await liveCode('active'))).statusCode).toBe(200);
  });

  it('saldos y fichas ajenos, iguales fila a fila (también los saldos viejos de las fichas); solo 9 saldos nuevos', async () => {
    const other = await wallet(s, venues.centro.id, 'demo-grupo');
    await ficha(s, other.id, venues.centro.id, { uid: '04CCCCCCCCCCCC' });
    const fixtureTokens = new Set(FIXTURES.map((f) => DEMO_FIXTURES[f].token));
    const snapshot = () =>
      s.sys(async (tx) => ({
        wallets: await tx.clientWallet.findMany({ orderBy: { id: 'asc' } }),
        cards: (await tx.walletCard.findMany({ orderBy: { id: 'asc' } })).filter((c) => !fixtureTokens.has(c.token)),
        venues: await tx.venue.findMany({ orderBy: { id: 'asc' } }),
        businesses: await tx.business.findMany({ orderBy: { id: 'asc' } }),
      }));
    const before = await snapshot();
    expect((await reset()).statusCode).toBe(204);
    const after = await snapshot();
    const known = new Set(before.wallets.map((w) => w.id));
    expect(after.wallets.filter((w) => known.has(w.id))).toEqual(before.wallets);
    expect(after.wallets.filter((w) => !known.has(w.id))).toHaveLength(9);
    expect(after.cards).toEqual(before.cards);
    expect(after.venues).toEqual(before.venues);
    expect(after.businesses).toEqual(before.businesses);
  });

  it('dos reinicios a la vez → el segundo no espera el candado (204 o 429 con Retry-After) y un saldo por ficha, como al principio', async () => {
    const [a, b] = await Promise.all([reset(CD), reset(OG)]);
    expect([a.statusCode, b.statusCode]).toContain(204);
    for (const r of [a, b].filter((x) => x.statusCode !== 204)) {
      expect(r.statusCode).toBe(429);
      expect(codeOf(r)).toBe('rate_limited');
      expect(r.headers['retry-after']).toBe('5');
    }
    const rows = await fixtureRows();
    expect(rows.size).toBe(9);
    expect(new Set([...rows.values()].map((c) => c.walletId)).size).toBe(9);
    for (const f of FIXTURES) expect(rows.get(DEMO_FIXTURES[f].token)!.wallet!.balanceCents, f).toBe(DEMO_FIXTURES[f].balanceCents);
  });

  it('con el candado tomado por otro reinicio: 429 rate_limited al momento, sin esperarlo', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let taken!: () => void;
    const isTaken = new Promise<void>((r) => (taken = r));
    const holder = s.sys(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtextextended('partner-demo-reset', 0))`;
      taken();
      await held;
    });
    await isTaken;
    const started = Date.now();
    const res = await reset(CD);
    release();
    await holder;
    expect(res.statusCode).toBe(429);
    expect(codeOf(res)).toBe('rate_limited');
    expect(res.headers['retry-after']).toBe('5');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('cinco reinicios por conexión y minuto; el sexto, 429 con Retry-After (otra conexión, aparte)', async () => {
    for (let i = 0; i < 5; i++) expect((await reset(CD)).statusCode).toBe(204);
    const sixth = await reset(CD);
    expect(sixth.statusCode).toBe(429);
    expect(codeOf(sixth)).toBe('rate_limited');
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThan(0);
    expect((await reset(OG)).statusCode).toBe(204);
  });

  it('resetDemoFixtures sin la semilla: lanza «Faltan las fichas de prueba» y no escribe nada', async () => {
    const err = await s
      .sys(async (tx) => {
        await tx.venue.update({ where: { slug: 'demo-otro-grupo' }, data: { slug: 'demo-otro-grupo-fuera' } });
        await resetDemoFixtures(tx);
      })
      .catch((e: unknown) => e as Error);
    expect((err as Error).message).toBe('Faltan las fichas de prueba: corre partner-demo-seed');
  });
});

describe('4. validación, claves, congelación, respuestas y Redis', () => {
  it('{ fixture: otra } → 422 param fixture; un campo de más → param can_pay; JSON sin cuerpo → 400 invalid_request', async () => {
    const other = await post(s.app, '/test/live-codes', CD, { body: { fixture: 'otra' }, headers: { 'accept-language': 'es' } });
    expect([other.statusCode, codeOf(other), (other.json() as { param?: string }).param]).toEqual([422, 'validation_failed', 'fixture']);
    expect(other.body).not.toContain('otra');
    const extra = await post(s.app, '/test/live-codes', CD, { body: { fixture: 'active', can_pay: true } });
    expect([extra.statusCode, codeOf(extra), (extra.json() as { param?: string }).param]).toEqual([422, 'validation_failed', 'can_pay']);
    const empty = await post(s.app, '/test/live-codes', CD, { headers: { 'content-type': 'application/json' } });
    expect([empty.statusCode, codeOf(empty)]).toEqual([400, 'invalid_request']);
    const none = await post(s.app, '/test/live-codes', CD);
    expect([none.statusCode, codeOf(none)]).toEqual([400, 'invalid_request']);
  });

  it('valen claves solo con wallet:balance o de Otro Grupo (cualquier clave de prueba)', async () => {
    for (const conn of [BAL, OG]) {
      const res = await post(s.app, '/test/live-codes', conn, { body: { fixture: 'active' } });
      expect(res.statusCode, res.body).toBe(201);
      expect((await reset(conn)).statusCode).toBe(204);
    }
    // El código de una clave de Otro Grupo sirve a Centro; desde Otro Grupo, active está fuera de alcance.
    const code = await liveCode('active', OG);
    expect((await balance(code)).statusCode).toBe(200);
    expect(codeOf(await balance(code, undefined, OG))).toBe('wallet_not_found');
  });

  it('congelación all → 404; money no las para', async () => {
    const setFreeze = async (freeze: 'none' | 'money' | 'all') => {
      await s.sys((tx) => tx.partnerApiState.upsert({ where: { id: 1 }, update: { freeze }, create: { id: 1, freeze } }));
      await clearRedis(s.redis);
    };
    try {
      await setFreeze('all');
      expect(codeOf(await post(s.app, '/test/live-codes', CD, { body: { fixture: 'active' } }))).toBe('not_found');
      expect((await reset()).statusCode).toBe(404);
      await setFreeze('money');
      expect((await post(s.app, '/test/live-codes', CD, { body: { fixture: 'active' } })).statusCode).toBe(201);
      expect((await reset()).statusCode).toBe(204);
    } finally {
      await setFreeze('none');
    }
  });

  it('las respuestas: su esquema, con no-store y Request-Id', async () => {
    const res = await post(s.app, '/test/live-codes', CD, { body: { fixture: 'ficha_uid' }, headers: { 'x-request-id': 'demo-code-1' } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(TestLiveCode.parse(body)).toEqual(body);
    expect(Object.keys(body).sort()).toEqual(['code', 'expires_in', 'livemode', 'object']);
    expect(body).toMatchObject({ object: 'test_live_code', expires_in: 60, livemode: false });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['request-id']).toBe('demo-code-1');
    expect(String(res.headers['content-type'])).toMatch(/^application\/json/);
  });

  it('Redis caído → 503 try_later (en el guard y al dar el código)', async () => {
    const get = vi.spyOn(s.redis, 'get').mockRejectedValue(new Error('Connection is closed.'));
    const down = await post(s.app, '/test/live-codes', CD, { body: { fixture: 'active' } });
    expect([down.statusCode, codeOf(down)]).toEqual([503, 'try_later']);
    expect((await reset()).statusCode).toBe(503);
    get.mockRestore();
    vi.spyOn(s.app.get(WalletLiveCodeService), 'issue').mockRejectedValueOnce(new ServiceUnavailableException({ code: 'TRY_LATER' }));
    const issue = await post(s.app, '/test/live-codes', CD, { body: { fixture: 'active' } });
    expect([issue.statusCode, codeOf(issue)]).toEqual([503, 'try_later']);
    expect(issue.headers['retry-after']).toBeDefined();
  });

  it('sin semilla: las dos, 500 internal_error y en el log «Faltan las fichas de prueba: corre partner-demo-seed»', async () => {
    const logged: string[] = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
    const token = DEMO_FIXTURES.active.token;
    await s.sys((tx) => tx.walletCard.update({ where: { token }, data: { token: `${token}-fuera` } }));
    try {
      const code = await post(s.app, '/test/live-codes', CD, { body: { fixture: 'active' } });
      expect([code.statusCode, codeOf(code)]).toEqual([500, 'internal_error']);
      await s.sys((tx) => tx.venue.update({ where: { slug: 'demo-otra-sociedad' }, data: { slug: 'demo-otra-sociedad-fuera' } }));
      const res = await reset();
      expect([res.statusCode, codeOf(res)]).toEqual([500, 'internal_error']);
    } finally {
      await s.sys(async (tx) => {
        await tx.walletCard.update({ where: { token: `${token}-fuera` }, data: { token } });
        await tx.venue.update({ where: { slug: 'demo-otra-sociedad-fuera' }, data: { slug: 'demo-otra-sociedad' } });
      });
    }
    expect(logged.filter((l) => l.includes('Faltan las fichas de prueba: corre partner-demo-seed'))).toHaveLength(2);
    expect((await reset()).statusCode).toBe(204);
  });
});

describe('5. nada sensible en el log, Sentry ni el registro', () => {
  it('live-codes, /wallet/balance y una carga con ese código o con ficha_uid y su UID no dejan OXC1:, ?ficha= ni el UID', async () => {
    expect((await reset()).statusCode).toBe(204);
    const reportError = vi.mocked(sentry.reportError);
    reportError.mockClear();
    const logged: string[] = [];
    const capture = (...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
    const spies = [
      ...(['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const).map((m) => vi.spyOn(Logger.prototype, m).mockImplementation(capture)),
      ...(['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const).map((m) => vi.spyOn(Logger, m).mockImplementation(capture)),
      ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(capture)),
    ];
    s.fastifyLog.length = 0;
    const since = await maxAuditId();
    let code = '';
    try {
      code = await liveCode('active');
      expect((await balance(code)).statusCode).toBe(200);
      expect((await load(CD, code, 1500)).statusCode).toBe(201);
      expect((await balance(fichaQr('ficha_uid'), UID)).statusCode).toBe(200);
      expect((await load(CD, fichaQr('ficha_uid'), 1500, { nfcUid: UID })).statusCode).toBe(201);
      expect((await load(CD, fichaQr('ficha_uid'), 1500, { nfcUid: '04DDDDDDDDDDDD' })).statusCode).toBe(409);
      expect((await reset()).statusCode).toBe(204);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const sentryText = JSON.stringify(reportError.mock.calls);
    const audits = await auditsSince(since);
    expect(audits.length).toBeGreaterThan(0);
    const auditText = JSON.stringify(audits, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v));
    const everything = [...logged, ...s.fastifyLog, sentryText, auditText].join('\n');
    expect(s.fastifyLog.length).toBeGreaterThan(0);
    for (const secret of ['OXC1:', code.slice(5), '?ficha=', DEMO_FIXTURES.ficha_uid.token, DEMO_FIXTURES.active.token, UID, '04DDDDDDDDDDDD', CD.key, CD.key.slice(9)]) {
      expect(everything, secret).not.toContain(secret);
    }
  });
});
