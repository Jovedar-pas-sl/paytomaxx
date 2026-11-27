import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEMO_FIXTURES, FIXTURES, Fixture, TestLiveCode, TestLiveCodeRequest, walletCardTokenFromUrl } from '@nightpay/contracts';
import { walletReachable } from '../wallet/partner-wallet-ref';
import { DEMO_BUSINESSES, DEMO_VENUES, demoSeedOptions } from './partner-demo-fixtures';

/**
 * Las fichas de prueba de la demo (PR 8 A2): la tabla del contrato
 * (Fixture), sus enlaces, a cuáles llega una clave de Local Demo Centro y las
 * opciones de la semilla (que se niega sin la API en test o sin las ayudas).
 */

type Json = Record<string, unknown>;
const pilot = JSON.parse(readFileSync(join(__dirname, '../../../../../../docs/partner-api/pilot/openapi-piloto.json'), 'utf8')) as Json;
const fixtureSchema = ((pilot.components as Json).schemas as Json).Fixture as { enum: string[]; description: string };

/** Las filas de la tabla del contrato: fixture → token, UID, saldo. */
function contractTable(): Map<string, { token: string; uid: string | null; balanceCents: number }> {
  const rows = fixtureSchema.description
    .split('\n')
    .map((l) => /^\| `([a-z_]+)` \| `([^`]+)` \| (none|`[0-9A-F]+`) \| (\d+) \|/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null);
  return new Map(rows.map((m) => [m[1]!, { token: m[2]!, uid: m[3] === 'none' ? null : m[3]!.slice(1, -1), balanceCents: Number(m[4]) }]));
}

describe('DEMO_FIXTURES y el contrato', () => {
  it('Fixture: el mismo enum, en el mismo orden, que pilot/openapi-piloto.json', () => {
    expect([...FIXTURES]).toEqual(fixtureSchema.enum);
    expect(Fixture.options).toEqual(fixtureSchema.enum);
    expect(Object.keys(DEMO_FIXTURES)).toEqual(fixtureSchema.enum);
  });

  it('cada ficha: el token, el UID guardado y el saldo de la tabla del contrato', () => {
    const table = contractTable();
    expect(table.size).toBe(9);
    for (const f of FIXTURES) expect(DEMO_FIXTURES[f], f).toEqual(table.get(f));
  });

  it('cada token pasa walletCardTokenFromUrl con el enlace de la demo', () => {
    for (const f of FIXTURES) {
      const { token } = DEMO_FIXTURES[f];
      expect(walletCardTokenFromUrl(`https://demo-operator.oxiopay.example/?ficha=${token}`), f).toBe(token);
    }
  });

  it('TestLiveCodeRequest: solo `fixture`, de la lista (el texto del contrato); TestLiveCode: el ejemplo del contrato', () => {
    expect(TestLiveCodeRequest.safeParse({ fixture: 'active' }).success).toBe(true);
    const bad = TestLiveCodeRequest.safeParse({ fixture: 'otra' });
    expect(bad.success).toBe(false);
    expect(bad.error!.issues[0]!.message).toBe('must be one of the demo fixtures.');
    expect(TestLiveCodeRequest.safeParse({ fixture: 'active', can_pay: true }).success).toBe(false);
    const example = { object: 'test_live_code', code: 'OXC1:K3J7Q2M9X4T8R6V1N5B0C2D7F9', expires_in: 60, livemode: false };
    expect(TestLiveCode.parse(example)).toEqual(example);
    expect(TestLiveCode.safeParse({ ...example, livemode: true }).success).toBe(false);
    expect(TestLiveCode.safeParse({ ...example, expires_in: 30 }).success).toBe(false);
  });
});

describe('apps/e2e/partner/fixtures.json (lo que comprueba demo-check.mjs)', () => {
  type E2eFixtures = {
    link: string;
    fixtures: Record<string, { token: string; uid: string | null; balanceCents: number }>;
    samples: Array<{ qr: string; status: number; code: string; reason?: string }>;
  };
  const e2e = JSON.parse(readFileSync(join(__dirname, '../../../../../e2e/partner/fixtures.json'), 'utf8')) as E2eFixtures;

  it('sus fichas son DEMO_FIXTURES (token, UID y saldo), en el mismo orden', () => {
    expect(Object.keys(e2e.fixtures)).toEqual([...FIXTURES]);
    for (const f of FIXTURES) {
      const { token, uid, balanceCents } = e2e.fixtures[f]!;
      expect({ token, uid, balanceCents }, f).toEqual(DEMO_FIXTURES[f]);
    }
  });

  it('el enlace de la guía, y los 7 textos de muestra de la tabla del contrato', () => {
    expect(e2e.link).toBe('https://demo-operator.oxiopay.example/?ficha=');
    const rows = fixtureSchema.description
      .split('\n')
      .map((l) => /^\| `([^`]+)` \| (?:`(\d{3}) ([a-z_]+)`)?(?:, )?(?:`reason: ([a-z_]+)`)? \|$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null);
    expect(rows).toHaveLength(7);
    expect(e2e.samples.map((s) => s.qr)).toEqual(rows.map((m) => m[1]));
    for (const [i, m] of rows.entries()) {
      const s = e2e.samples[i]!;
      expect(s.reason, s.qr).toBe(m[4]);
      if (m[2]) expect([s.status, s.code], s.qr).toEqual([Number(m[2]), m[3]]);
      else expect([s.status, s.code], s.qr).toEqual([422, 'wallet_ref_not_accepted']);
    }
  });
});

describe('a qué fichas llega una clave de Local Demo Centro', () => {
  // Las sociedades y los locales de la semilla, con ids inventados.
  const biz = { main: 'b-main', other: 'b-other' } as const;
  const venues = Object.fromEntries(
    Object.entries(DEMO_VENUES).map(([k, v]) => [k, { id: `v-${k}`, walletGroup: v.walletGroup, businessId: biz[v.business] }]),
  ) as Record<keyof typeof DEMO_VENUES, { id: string; walletGroup: string; businessId: string }>;
  const homeOf = (f: string) => (f === 'other_group' ? venues.otroGrupo : f === 'other_company' ? venues.otraSociedad : venues.centro);
  const centro = venues.centro;

  it('niega other_group y other_company y admite el resto', () => {
    const reach = Object.fromEntries(
      FIXTURES.map((f) => {
        const home = homeOf(f);
        return [f, walletReachable({ tenantId: home.id, walletGroup: home.walletGroup }, { businessId: home.businessId }, { tenantId: centro.id, walletGroup: centro.walletGroup, businessId: centro.businessId })];
      }),
    );
    expect(Object.entries(reach).filter(([, ok]) => !ok).map(([f]) => f)).toEqual(['other_group', 'other_company']);
  });

  it('los nombres y NIF de la demo', () => {
    expect(DEMO_BUSINESSES).toEqual({ main: { name: 'Empresa Demo S.L.', taxId: 'B00000000' }, other: { name: 'Otra Empresa Demo S.L.', taxId: 'B00000001' } });
    expect(Object.values(DEMO_VENUES).map((v) => [v.slug, v.name, v.walletGroup])).toEqual([
      ['demo-centro', 'Local Demo Centro', 'demo-grupo'],
      ['demo-otra-sociedad', 'Local Demo Otra Sociedad', 'demo-grupo'],
      ['demo-otro-grupo', 'Local Demo Otro Grupo', 'demo-otro-grupo'],
    ]);
  });
});

describe('demoSeedOptions (pura: se niega antes de abrir la base)', () => {
  const DEMO = { PARTNER_API_ENABLED: 'true', PARTNER_API_MODE: 'test', PARTNER_TEST_HELPERS: '1' };

  it('sin la API en test se niega', () => {
    for (const env of [{ ...DEMO, PARTNER_API_MODE: 'live' }, { ...DEMO, PARTNER_API_ENABLED: 'false' }, { PARTNER_TEST_HELPERS: '1' }]) {
      const r = demoSeedOptions(env, []);
      expect(r.ok, JSON.stringify(env)).toBe(false);
      expect(!r.ok && r.reason).toMatch(/API en test/);
    }
  });

  it('sin las ayudas se niega (también con 0 o true)', () => {
    for (const v of [undefined, '0', 'true']) {
      const r = demoSeedOptions({ ...DEMO, PARTNER_TEST_HELPERS: v }, []);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toMatch(/PARTNER_TEST_HELPERS=1/);
    }
  });

  it('--carga 501, -1, abc o sin número se niega; sin ella, 300; 0 y 500 valen', () => {
    for (const argv of [['--carga', '501'], ['--carga', '-1'], ['--carga', 'abc'], ['--carga'], ['--carga=1.5'], ['--carga=']]) {
      const r = demoSeedOptions(DEMO, argv);
      expect(r.ok, argv.join(' ')).toBe(false);
      expect(!r.ok && r.reason).toMatch(/--carga/);
    }
    expect(demoSeedOptions(DEMO, [])).toEqual({ ok: true, carga: 300 });
    expect(demoSeedOptions(DEMO, ['--carga', '0'])).toEqual({ ok: true, carga: 0 });
    expect(demoSeedOptions(DEMO, ['--carga=500'])).toEqual({ ok: true, carga: 500 });
    expect(demoSeedOptions(DEMO, ['--carga', '42'])).toEqual({ ok: true, carga: 42 });
  });
});
