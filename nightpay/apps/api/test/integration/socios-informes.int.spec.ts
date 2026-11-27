// Integración (Postgres y Redis de verdad, FORCE RLS, TENANCY_UNSCOPED_QUERIES=throw): el
// efectivo de los cajeros de otras plataformas en el cierre, el mapa del dinero, los CSV y
// «Movimientos» (PR 3 parte B de la API de socios). Pregunta 8, decidida por recomendación
// (pendiente del sí del dueño): ese efectivo se cuenta aparte, cada mañana, contra «Caja ·
// {socio}» y «Movimientos»; el arqueo de recepción nunca lo espera en su cajón.
//
// La noche (reloj falso, de 21:00 a 02:00 de Madrid): 100 € cobrados en recepción; tres cargas de
// 30 € desde dos cajeros (ATM0042 ×2 y ATM0007); una carga de 20 € anulada por la API y otra de 15 €
// anulada en el panel con 2FA; y la anulación en el panel de una carga de 25 € de la noche anterior.
// Neto de los cajeros en la noche: 90 + 20 − 20 + 15 − 15 − 25 = 65 €. Montaje: test/support/socios.ts.
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { evaluateCash, type MoneyMap, type PartnerOwnerStatement, type StatementBody, type WalletLoadBody } from '@nightpay/contracts';
import { IncidentsService } from '../../src/modules/incidents/incidents.service';
import { WalletFichaService } from '../../src/modules/money-map/wallet-ficha.service';
import { MoneyMapService } from '../../src/modules/money-map/money-map.service';
import { CloseCheckService } from '../../src/modules/nights/close-check.service';
import { cashFromRows } from '../../src/modules/nights/night-rules';
import { NightsService } from '../../src/modules/nights/nights.service';
import { recargasEfectivoCsv, recargasSociosCsv } from '../../src/modules/reports/export-csv';
import { PeriodReportsService } from '../../src/modules/reports/period-reports.service';
import { ReportsService } from '../../src/modules/reports/reports.service';
import { saldoCredits } from '../../src/modules/wallets/wallet-fee-saldo';
import {
  TOTP,
  business,
  clearRedis,
  connection,
  ficha,
  mountSocios,
  newKey,
  partner,
  staffToken,
  venue,
  wallet,
  type Seeded,
  type Socios,
  type TestConnection,
  type TestWallet,
} from '../support/socios';

vi.mock('../../src/common/observability/sentry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/common/observability/sentry')>()),
  reportError: vi.fn(),
}));

const T = (iso: string) => new Date(iso);
// La noche anterior: 00:00 de Madrid del 26-nov.
const PREV_NIGHT = T('2026-11-25T23:00:00Z');
// Esta noche: abierta a las 21:00 de Madrid; las cargas hacia las 00:00; se cierra a las 02:00.
const OPENED = T('2026-11-26T20:00:00Z');
const CLOSE_AT = T('2026-11-27T01:00:00Z');

let s: Socios;
const G = `ginformes-${Math.random().toString(36).slice(2, 8)}`;
let A: Seeded;
let B: Seeded;
let PA: TestConnection;
let PB: TestConnection;
let partnerName = '';
let nightId = '';
let w1: TestWallet;
let w2: TestWallet;
let reports: ReportsService;
let checks: CloseCheckService;
let moneyMap: MoneyMapService;
let nights: NightsService;
let periods: PeriodReportsService;
let fichas: WalletFichaService;
const loads: Record<string, WalletLoadBody> = {};
/** El `qr` de la ficha de cada saldo (una ficha por saldo). */
const qrOf = new Map<string, string>();

const at = (iso: string) => vi.setSystemTime(T(iso));
const window = () => ({ from: OPENED, to: CLOSE_AT });
const uuidOf = (publicId: string) => {
  const h = publicId.slice(3);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/** Una petición del panel de ese local (como tras AuthGuard): su local en el contexto. */
function asStaff<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return s.cls.run(async () => {
    s.cls.set('ctx', { traceId: `t-${tenantId.slice(0, 4)}`, tenantId });
    return fn();
  });
}

async function loaded(conn: TestConnection, w: TestWallet, amount: number, device: string, description = 'Recarga en cajero'): Promise<WalletLoadBody> {
  const key = newKey(device);
  const res = await s.app.inject({
    method: 'POST',
    url: '/v1/partner/wallet/loads',
    headers: { authorization: `Bearer ${conn.key}`, 'idempotency-key': key },
    payload: { qr: qrOf.get(w.id), amount, description, funding: 'cash', device, reference: key },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as WalletLoadBody;
}

async function panel(method: 'GET' | 'POST', v: Seeded, path: string, body?: object) {
  const t = await staffToken(s, v.owner, v.venueId, 'OWNER');
  return s.app.inject({ method, url: `/v1/admin/partner-connections${path}`, headers: { authorization: `Bearer ${t}` }, ...(body ? { payload: body } : {}) });
}

async function panelVoid(conn: TestConnection, l: WalletLoadBody, reason: string) {
  const res = await panel('POST', A, `/${conn.id}/loads/${uuidOf(l.id)}/void`, { reason, totpCode: TOTP });
  expect(res.statusCode, res.body).toBe(200);
}

const ownersSum = (m: MoneyMap) => {
  const o = m.where.owners;
  return o.venueCents + o.staffCents + o.saldoCents + (o.oxioPayCents ?? 0) + (o.paidOutCents ?? 0) + (o.commissionsCents ?? 0);
};

beforeAll(async () => {
  vi.stubEnv('PARTNER_API_ENABLED', 'true');
  vi.stubEnv('PARTNER_API_MODE', 'test');
  vi.stubEnv('EDITION', 'club');
  s = await mountSocios();
  await clearRedis(s.redis);
  reports = new ReportsService(s.prisma);
  const config = { get: () => undefined, getOrThrow: () => undefined };
  checks = new CloseCheckService(s.prisma, new IncidentsService(s.prisma, { log: async () => undefined } as never), config as never);
  moneyMap = new MoneyMapService(s.prisma, reports, config as never);
  nights = new NightsService(s.prisma, reports, { log: async () => undefined } as never, checks, undefined, moneyMap);
  periods = new PeriodReportsService(s.prisma);
  fichas = new WalletFichaService(s.prisma);

  // Las sociedades con el reloj de verdad (su NIF de prueba sale de Date.now()).
  const X = await business(s, 'Sociedad Informes');
  const Y = await business(s, 'Sociedad Otra');
  vi.useFakeTimers({ toFake: ['Date'] });
  at('2026-11-25T22:00:00Z');
  A = await venue(s, 'Sala Informes', G, X);
  B = await venue(s, 'Sala Otra', `${G}-b`, Y);
  const P = await partner(s);
  partnerName = (await s.sys((tx) => tx.partner.findUniqueOrThrow({ where: { id: P } }))).name;
  PA = await connection(s, { venueId: A.venueId, businessId: X, partnerId: P });
  PB = await connection(s, { venueId: B.venueId, businessId: Y, partnerId: await partner(s) });
  w1 = await wallet(s, A.venueId, G, { balanceCents: 0 });
  w2 = await wallet(s, A.venueId, G, { balanceCents: 0 });
  for (const w of [w1, w2]) qrOf.set(w.id, await ficha(s, w.id, A.venueId));

  // La noche anterior: 25 € en ATM0007 (se anula en el panel esta noche).
  vi.setSystemTime(PREV_NIGHT);
  loads.prev = await loaded(PA, w2, 2500, 'ATM0007');

  // Esta noche.
  nightId = (
    await s.sys((tx) => tx.venueNight.create({ data: { tenantId: A.venueId, openedAt: OPENED, openedBy: A.manager, openingFloatCents: 0 } }))
  ).id;
  // 100 € cobrados en recepción.
  await s.sys((tx) =>
    tx.walletCashTopUp.create({
      data: { tenantId: A.venueId, walletId: w1.id, amountCents: 10_000, takenByUserId: A.owner, idempotencyKey: `inf-${G}`, createdAt: T('2026-11-26T21:00:00Z') },
    }),
  );
  at('2026-11-26T23:00:00Z');
  loads.a1 = await loaded(PA, w1, 3000, 'ATM0042', '=1+1');
  loads.a2 = await loaded(PA, w1, 3000, 'ATM0042');
  loads.b1 = await loaded(PA, w2, 3000, 'ATM0007');
  loads.apiVoided = await loaded(PA, w1, 2000, 'ATM0042');
  loads.panelVoided = await loaded(PA, w2, 1500, 'ATM0007');
  at('2026-11-26T23:05:00Z');
  const v = await s.app.inject({ method: 'POST', url: `/v1/partner/wallet/loads/${loads.apiVoided.id}/void`, headers: { authorization: `Bearer ${PA.key}` } });
  expect(v.statusCode, v.body).toBe(200);
  at('2026-11-26T23:30:00Z');
  await panelVoid(PA, loads.panelVoided, 'El cliente no pagó');
  // La de la noche anterior (hace 24,5 h: dentro de las 36 h).
  await panelVoid(PA, loads.prev, 'Billete falso');
  at('2026-11-27T01:00:00Z');
}, 60_000);

afterAll(async () => {
  vi.useRealTimers();
  await s?.close();
  vi.unstubAllEnvs();
});

describe('1. el arqueo de recepción no espera el efectivo de los cajeros', () => {
  it('cash() y cashFromRows() dan lo mismo; el cajón espera solo los 100 € de recepción; «Caja · {socio}» = net_loads de /statement en la ventana del Z', async () => {
    const viaSql = await asStaff(A.venueId, () => checks.cash(A.venueId, window(), 0));
    const viaRows = await asStaff(A.venueId, async () =>
      cashFromRows(0, {
        recargasEfectivo: await reports.recargasEfectivo(A.venueId, window()),
        pagosSaldo: await reports.pagosSaldo(A.venueId, window()),
        liquidaciones: await reports.liquidaciones(A.venueId, window()),
      }),
    );
    expect(viaSql).toEqual(viaRows);
    expect(viaSql).toMatchObject({ cashInCents: 10_000, walletCashTopUpsCount: 1, walletCashTopUpsCents: 10_000, expectedCents: 10_000 });
    // 5 cargas − 3 anulaciones; 65 €.
    expect(viaSql.partnerCash).toEqual([{ name: partnerName, count: 2, cents: 6500 }]);
    const st = await s.app.inject({
      method: 'GET',
      url: `/v1/partner/statement?from=${OPENED.toISOString()}&to=${CLOSE_AT.toISOString()}`,
      headers: { authorization: `Bearer ${PA.key}` },
    });
    expect(st.statusCode, st.body).toBe(200);
    expect((st.json() as StatementBody).net_loads).toBe(6500);
  });
});

describe('2-4. el cierre, el Z, el mapa del dinero, el IVA y los CSV', () => {
  let z: Awaited<ReturnType<NightsService['close']>>['z'];

  it('2. contando 100 € cuadra; el Z congelado lleva caja.partnerCash y el mapa partnerCashCents una sola vez', async () => {
    const check = await asStaff(A.venueId, () => nights.closeCheck(A.venueId));
    expect(check.cash.expectedCents).toBe(10_000);
    // A ciegas: el paso «Efectivo» no dice lo esperado ni el efectivo de los cajeros.
    const efectivo = check.steps.find((st) => st.key === 'efectivo')!;
    expect(efectivo.detail).not.toContain('100,00');
    expect(efectivo.detail).not.toContain(partnerName);
    expect(evaluateCash(check.cash, { countedCents: 10_000 })).toMatchObject({ status: 'ok', diffCents: 0, detail: expect.stringContaining('La caja cuadra') });
    const warned = check.steps.filter((st) => st.status === 'warn' && st.key !== 'efectivo').map((st) => st.key);
    const closed = await asStaff(A.venueId, () =>
      nights.close(A.venueId, { userId: A.owner, role: 'OWNER' }, nightId, { cashCountedCents: 10_000, acknowledged: warned, note: 'prueba' }),
    );
    z = closed.z;
    expect(z.caja).toMatchObject({ expectedCents: 10_000, countedCents: 10_000, diffCents: 0, partnerCash: [{ name: partnerName, count: 2, cents: 6500 }] });
    const row = await s.sys((tx) => tx.venueNight.findUniqueOrThrow({ where: { id: nightId } }));
    expect(row).toMatchObject({ cashExpectedCents: 10_000, cashCountedCents: 10_000, cashDiffCents: 0 });
    const frozen = row.zReport as unknown as { moneyMap: MoneyMap; caja: { partnerCash: unknown } };
    const where = frozen.moneyMap.where;
    expect(where.partnerCashCents).toBe(6500);
    expect(where.cashBoxCents).toBe(10_000);
    expect(where.totalCents).toBe(where.bbvaCents + where.cashBoxCents + 6500 + (where.bitcoinCents ?? 0));
    expect(ownersSum(frozen.moneyMap)).toBe(where.totalCents);
    // Las recargas en efectivo del mapa ya incluyen la de los cajeros (por eso cuadra): 100 + 65.
    expect(frozen.moneyMap.inflow.topUps.cashCents).toBe(16_500);
    // Congelado: verlo otra vez no lo recalcula.
    expect(frozen.caja.partnerCash).toEqual(z.caja!.partnerCash);
    const again = await asStaff(A.venueId, () => moneyMap.forQuery(A.venueId, { night: nightId } as never));
    expect(again.where.partnerCashCents).toBe(6500);
  });

  it('3. el resumen del Z y el IVA cuentan una sola vez las recargas en efectivo; saldoCredits() como antes', async () => {
    expect(z.summary).toMatchObject({ walletCashTopUpsCents: 16_500, walletCashTopUpsCount: 3 });
    const totals = await asStaff(A.venueId, () => periods.totals(A.venueId, window()));
    expect(Number(totals.walletCashTopUpCents)).toBe(16_500);
    // La carga del cajero va sin comisión del servicio.
    const credits = await s.sys((tx) => saldoCredits(tx, w1.id));
    expect(credits.reduce((a, c) => a + c.cents, 0)).toBe(10_000 + 3000 + 3000);
    expect(credits.filter((c) => c.withServiceFee)).toEqual([]);
  });

  it('4. recargas-socios suma el neto (la anulación de la noche anterior en negativo aquí); «=» no es fórmula; recargas-efectivo dice «{socio} (plataforma)»', async () => {
    const rows = await asStaff(A.venueId, () => reports.recargasSocios(A.venueId, window()));
    expect(rows.reduce((a, r) => a + (r.kind === 'LOAD_VOID' ? -r.amountCents : r.amountCents), 0)).toBe(6500);
    const csv = recargasSociosCsv(rows);
    expect(csv).toContain(`;Anulación;-25,00;Efectivo;ATM0007;`);
    expect(csv).toContain(";'=1+1;");
    expect(csv).toContain(';Billete falso;');
    expect(csv).toMatch(/;Anulación;-20,00;Efectivo;ATM0042;.*;La plataforma;wl_/);
    const efectivo = recargasEfectivoCsv(await asStaff(A.venueId, () => reports.recargasEfectivo(A.venueId, window())));
    expect(efectivo.split('\r\n').filter((l) => l.includes(`;${partnerName} (plataforma);`))).toHaveLength(8);
    // Y la ficha del saldo: el cajero, como «{socio} (plataforma)».
    const f = await asStaff(A.venueId, () => fichas.ficha(A.venueId, w2.id));
    const byPartner = f.topUps.filter((t) => t.by?.role === 'PARTNER');
    expect(byPartner.length).toBeGreaterThan(0);
    expect(byPartner.every((t) => t.by!.name === `${partnerName} (plataforma)` && t.by!.id === PA.id)).toBe(true);
  });
});

describe('5. «Movimientos» del dueño', () => {
  it('byDevice suma net_loads; el /statement del socio = el del dueño sin byDevice; otro local, 404', async () => {
    const own = await panel('GET', A, `/${PA.id}/statement?business_date=2026-11-26`);
    expect(own.statusCode, own.body).toBe(200);
    const st = own.json() as PartnerOwnerStatement;
    expect(st.net_loads).toBe(6500);
    expect(st.byDevice).toEqual([
      { device: 'ATM0007', loadsCount: 2, voidsCount: 2, netCents: 3000 + 1500 - 1500 - 2500 },
      { device: 'ATM0042', loadsCount: 3, voidsCount: 1, netCents: 3000 + 3000 + 2000 - 2000 },
    ]);
    expect(st.byDevice.reduce((a, d) => a + d.netCents, 0)).toBe(st.net_loads);
    const list = await panel('GET', A, `/${PA.id}/loads?business_date=2026-11-26`);
    expect(list.statusCode, list.body).toBe(200);
    expect((list.json() as { loads: unknown[] }).loads).toHaveLength(5);

    const theirs = await s.app.inject({ method: 'GET', url: `/v1/partner/statement?from=${st.from}&to=${st.to}`, headers: { authorization: `Bearer ${PA.key}` } });
    expect(theirs.statusCode, theirs.body).toBe(200);
    const { byDevice: _owner, ...withoutDevices } = st;
    expect(theirs.json()).toEqual(withoutDevices);
    expect('byDevice' in (theirs.json() as object)).toBe(false);

    for (const path of [`/${PA.id}/statement?business_date=2026-11-26`, `/${PA.id}/loads?business_date=2026-11-26`]) {
      const other = await panel('GET', B, path);
      expect(other.statusCode).toBe(404);
    }
    // Y la conexión de B no ve nada de A.
    expect(PB.tenantId).toBe(B.venueId);
  });
});
