import { describe, expect, it } from 'vitest';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { evaluateCash, type MoneyMap } from '@nightpay/contracts';
import { blindMoneyMap, blindNightView, blindsCash } from './blind-cash';
import { blindCashCountResult } from './nights.service';
import { summarize } from '../reports/export-csv';
import type { PagoSaldoRow, RecargaEfectivoRow } from '../reports/export-rows';
import { PeriodReportsController } from '../reports/period-reports.controller';
import { PeriodReportsService } from '../reports/period-reports.service';
import { ReportsController } from '../reports/reports.controller';
import { EMPTY_TOTALS } from '../reports/period-totals';
import { buildMoneyMap, type MoneyMapInput, type SaleRow } from '../money-map/money-map-rules';
import { AdminWalletsController } from '../wallets/wallets.controller';
import { CASH_TOP_UP_LABEL } from '../reports/export-summary';
import type { NightView } from './nights.service';
import { NightsController } from './nights.controller';
import { MoneyMapController } from '../money-map/money-map.controller';

// La noche del ejemplo del dueño: 200 € de fondo + 1.770 € de recargas en efectivo − 60 € devueltos = 1.910 €.
function view(): NightView {
  return {
    id: 'n-1', openedAt: '2026-11-26T21:00:00.000Z', closedAt: null, autoClosed: false, pendingAtClose: 0, closeNote: null,
    openingFloatCents: 20_000,
    pending: [],
    z: {
      from: '2026-11-26T21:00:00.000Z', to: '2026-11-26T23:00:00.000Z', generatedAt: '2026-11-26T23:00:00.000Z', pendingCount: 0,
      summary: {
        chargedCents: 300_000, netCents: 294_000, walletCashTopUpsCount: 12, walletCashTopUpsCents: 177_000, serviceFeeCashCents: 500,
        walletCashPayoutsCount: 1, walletCashPayoutsCents: 6_000,
        byType: [{ label: 'Servicios', count: 3, chargedCents: 123_000 }, { label: CASH_TOP_UP_LABEL, count: 12, chargedCents: 177_000 }],
      } as unknown as NightView['z']['summary'],
    },
  };
}

function map(): MoneyMap {
  return {
    scope: { kind: 'night', nightId: 'n-1', open: true },
    inflow: { cashCents: 0, topUps: { totalCents: 227_000, cardCents: 50_000, cashCents: 177_000, count: 14 } },
    where: { bbvaCents: 100_000, cashBoxCents: 191_000, cashBox: { openingFloatCents: 20_000, inCents: 177_000, outCents: 6_000 }, totalCents: 291_000,
      owners: { venueCents: 120_000, staffCents: 0, saldoCents: 171_000 }, liveSaldoCents: 171_000, owed: null },
    outflow: { refunds: { cardCents: 0, cardCount: 0, cashCents: 6_000, cashCount: 1 } },
    serviceFee: { salesCents: 0, topUpsCents: 500, cashCents: 500, refundedCents: 0, owedCents: 500 },
  } as unknown as MoneyMap;
}

describe('cierre a ciegas: la encargada con la noche abierta', () => {
  it('solo la encargada (MANAGER) y solo con la noche abierta; el dueño lo ve todo', () => {
    expect(blindsCash('MANAGER', true)).toBe(true);
    expect(blindsCash('MANAGER', false)).toBe(false);
    expect(blindsCash('OWNER', true)).toBe(false);
  });

  it('Noches → En vivo no trae el fondo, las recargas en efectivo ni el saldo devuelto en efectivo', () => {
    const v = blindNightView(view());
    expect(v.openingFloatCents).toBeNull();
    expect(v.cashHidden).toBe(true);
    const s = v.z.summary as unknown as Record<string, unknown>;
    expect(s.walletCashTopUpsCents).toBeUndefined();
    expect(s.walletCashTopUpsCount).toBeUndefined();
    expect(s.serviceFeeCashCents).toBeUndefined();
    expect(s.walletCashPayoutsCents).toBe(0);
    expect(v.z.summary.byType.map((t) => t.label)).toEqual(['Servicios']);
    // Ninguna de las tres cifras del ejemplo sale en la respuesta.
    const json = JSON.stringify(v);
    for (const n of ['20000', '177000', '6000', '191000']) expect(json).not.toContain(`:${n}`);
  });

  it('el mapa del dinero en directo no trae la caja esperada ni lo que la forma', () => {
    const m = blindMoneyMap(map());
    expect(m.where.cashHidden).toBe(true);
    expect(m.where.cashBoxCents).toBe(0);
    expect(m.where.cashBox).toEqual({ openingFloatCents: null, inCents: 0, outCents: 0 });
    // Tampoco se saca restando: el total de «dónde está» y el de recargas van sin el efectivo.
    expect(m.where.totalCents).toBe(100_000);
    expect(m.inflow.topUps).toMatchObject({ totalCents: 50_000, cashCents: 0 });
    expect(m.outflow.refunds).toMatchObject({ cashCents: 0, cashCount: 0 });
    expect(m.serviceFee?.cashCents).toBe(0);
  });
});

describe('cierre a ciegas en el API (no solo en la pantalla)', () => {
  const user = (role: string) => ({ sub: 'u-1', tenantId: 't-1', role }) as never;

  it('GET /nights/current y /nights/:id: a la encargada no le llega el fondo; al dueño, sí; cerrada, a todos', async () => {
    const closed = { ...view(), closedAt: '2026-11-27T05:00:00.000Z' };
    const svc = { current: async () => view(), get: async () => closed, open: async () => view() };
    const c = new NightsController(svc as never);
    expect((await c.current(user('MANAGER'))).night?.openingFloatCents).toBeNull();
    expect((await c.open(user('MANAGER'), {})).openingFloatCents).toBeNull();
    expect((await c.current(user('OWNER'))).night?.openingFloatCents).toBe(20_000);
    expect((await c.get(user('MANAGER'), 'n-1')).openingFloatCents).toBe(20_000);
  });

  it('las horas del minigráfico: el controlador pasa quién mira, para que el servicio las saque sin el efectivo', async () => {
    const roles: Array<string | undefined> = [];
    const svc = {
      current: async (_t: string, role?: string) => (roles.push(role), view()),
      open: async (_t: string, _u: string, _f?: number, role?: string) => (roles.push(role), view()),
      get: async (_t: string, _id: string, role?: string) => (roles.push(role), view()),
    };
    const c = new NightsController(svc as never);
    await c.current(user('MANAGER'));
    await c.open(user('MANAGER'), {});
    await c.get(user('OWNER'), 'n-1');
    expect(roles).toEqual(['MANAGER', 'MANAGER', 'OWNER']);
  });

  it('GET /admin/money-map: en directo, a la encargada no le llega la caja esperada; una noche cerrada o unas fechas, sí', async () => {
    let m = map();
    const c = new MoneyMapController({ forQuery: async () => m } as never, {} as never);
    expect((await c.get(user('MANAGER'), {})).where.cashBoxCents).toBe(0);
    expect((await c.get(user('OWNER'), {})).where.cashBoxCents).toBe(191_000);
    m = { ...map(), scope: { kind: 'night', nightId: 'n-0', open: false } };
    expect((await c.get(user('MANAGER'), { night: 'n-0' })).where.cashBoxCents).toBe(191_000);
  });
});

// ─── Tampoco restando: lo que llega a la encargada es lo mismo con o sin efectivo ───

const AT = new Date('2026-11-26T22:00:00Z');
const recarga = (id: string, amountCents: number, serviceFeeCents = 0): RecargaEfectivoRow => ({
  id, at: AT, amountCents, serviceFeeCents, takenByName: 'Javi', takenByEmail: 'javi@x.es', terminalLabel: null,
});
const devuelto = (method: 'CASH' | 'CARD', amountCents: number): PagoSaldoRow => ({
  id: `wp-${method}`, at: AT, amountCents, method, paidByName: null, paidByEmail: 'javi@x.es',
});
const nightOf = (summary: NightView['z']['summary']): NightView => ({ ...view(), z: { ...view().z, summary } });

function mapInput(cash: boolean): MoneyMapInput {
  return {
    scope: { kind: 'night', nightId: 'n-1', open: true },
    window: { from: new Date('2026-11-26T20:00:00Z'), to: new Date('2026-11-27T02:00:00Z') },
    now: new Date('2026-11-27T02:00:00Z'),
    frozen: false,
    sales: [{ amountCents: 15_000, tipCents: 500, category: 'CHICA_SERVICE', method: 'CARD', platformBps: 1000, lines: [] } as SaleRow],
    topUps: { cardCents: 20_000, cardCount: 1, cardFeeCents: 400, cashCents: cash ? 177_000 : 0, cashCount: 0, cashFeeCents: cash ? 3_000 : 0 },
    staff: { chicas: { grossCents: 13_500, unpaidCents: 13_500 }, camareros: { grossCents: 0, unpaidCents: 0 } },
    cardRefunds: { cents: 1_000, count: 1 },
    walletPayouts: { cashCents: cash ? 6_000 : 0, cashCount: cash ? 1 : 0, cardCents: 500 },
    payouts: [],
    cashBox: cash
      ? { openingFloatCents: 20_000, inCents: 180_000, outCents: 6_000, expectedCents: 194_000 }
      : { openingFloatCents: null, inCents: 0, outCents: 0, expectedCents: 0 },
    bankFeeBps: null,
    liveSaldoCents: cash ? 200_000 : 30_000,
    owed: { chicasCents: 13_500, camarerosCents: 0 },
  };
}

describe('cierre a ciegas: nada del efectivo sale restando', () => {
  it('Noches → En vivo: lo cobrado, el neto, el neto sin el personal y la comisión, como si no hubiera habido efectivo', () => {
    const withCash = summarize([], [], [], [], [devuelto('CASH', 6_000), devuelto('CARD', 500)], [recarga('c1', 100_000, 2_000), recarga('c2', 77_000, 1_000)]);
    const noCash = summarize([], [], [], [], [devuelto('CARD', 500)], []);
    expect(blindNightView(nightOf(withCash)).z.summary).toEqual(blindNightView(nightOf(noCash)).z.summary);
    const json = JSON.stringify(blindNightView(nightOf(withCash)));
    for (const n of ['177000', '180000', '3000', '6000']) expect(json).not.toContain(`:${n}`);
  });

  it('el mapa del dinero: «dónde está», «de quién es», las recargas y la comisión, como si no hubiera habido efectivo', () => {
    const strip = (m: MoneyMap) => ({ ...m, inflow: { ...m.inflow, topUps: { ...m.inflow.topUps, count: 0 } } });
    const withCash = blindMoneyMap(buildMoneyMap(mapInput(true)));
    const noCash = blindMoneyMap(buildMoneyMap(mapInput(false)));
    expect(strip(withCash)).toEqual(strip(noCash));
    // «De quién es» sigue sumando lo de «dónde está».
    const o = withCash.where.owners;
    expect(o.venueCents + o.staffCents + o.saldoCents + (o.oxioPayCents ?? 0) + (o.paidOutCents ?? 0) + (o.commissionsCents ?? 0)).toBe(
      withCash.where.totalCents,
    );
  });
});

describe('cierre a ciegas: las otras vías del API', () => {
  const user = (role: string) => ({ sub: 'u-1', tenantId: 't-1', role }) as never;
  const openFrom = new Date('2026-11-26T21:00:00Z');

  it('money-map con from/to que llegan a la noche abierta: a la encargada, sin la caja; antes de abrirla o al dueño, con ella', async () => {
    const period = (to: string): MoneyMap => ({ ...map(), scope: { kind: 'period' }, to }) as MoneyMap;
    let m = period('2026-11-27T01:00:00.000Z');
    const svc = { forQuery: async () => m, currentWindow: async () => ({ from: openFrom, to: new Date(), nightId: 'n-1', open: true, openingFloatCents: 20_000 }) };
    const c = new MoneyMapController(svc as never, {} as never);
    expect((await c.get(user('MANAGER'), { from: '2026-11-26', to: '2026-11-26' })).where.cashBoxCents).toBe(0);
    expect((await c.get(user('OWNER'), { from: '2026-11-26', to: '2026-11-26' })).where.cashBoxCents).toBe(191_000);
    m = period('2026-11-26T00:00:00.000Z');
    expect((await c.get(user('MANAGER'), { from: '2026-11-25', to: '2026-11-25' })).where.cashBoxCents).toBe(191_000);
  });

  it('GET /admin/reports/z: con la noche abierta, la encargada no puede pedir sus horas (403); el dueño sí; sin noche abierta, igual que antes', async () => {
    let open: Date | null = openFrom;
    const svc = { openNightStart: async () => open, periodZ: async () => ({ summary: { walletCashTopUpCents: 177_000 } }) };
    const c = new PeriodReportsController(svc as never);
    const q = { from: '2026-11-26T20:00:00.000Z', to: '2026-11-26T23:00:00.000Z' };
    await expect(c.zReport(user('MANAGER'), 't-1', q)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(c.zReport(user('OWNER'), 't-1', q)).resolves.toBeTruthy();
    // Unas horas que acaban antes de abrir la noche: sí.
    await expect(c.zReport(user('MANAGER'), 't-1', { from: q.from, to: '2026-11-26T20:30:00.000Z' })).resolves.toBeTruthy();
    open = null;
    await expect(c.zReport(user('MANAGER'), 't-1', q)).resolves.toBeTruthy();
  });

  it('GET /admin/metrics: con la noche abierta, a la encargada sin recargas ni saldo devuelto en efectivo (ni en lo cobrado o el neto); al dueño o sin noche, igual', async () => {
    // 500 € con tarjeta + 1.770 € de recargas en efectivo (5 € de comisión) − 60 € devueltos en efectivo.
    const totals = {
      ...EMPTY_TOTALS, paymentCount: 4, grossCents: 50_000, walletCashTopUpCount: 12, walletCashTopUpCents: 177_000,
      walletCashTopUpFeeCents: 500, walletCashPayoutCount: 1, walletCashPayoutCents: 6_000,
    };
    const svc = new PeriodReportsService({} as never);
    Object.assign(svc, { totals: async () => totals, statusCounts: async () => [] });
    let open: Date | null = openFrom;
    svc.openNightStart = async () => open;
    const c = new PeriodReportsController(svc);
    const blind = (await c.metrics(user('MANAGER'), 't-1')) as Record<string, unknown> & { today: Record<string, number> };
    expect(blind.cashHidden).toBe(true);
    expect(blind.today).toMatchObject({ walletCashTopUpCents: 0, walletCashPayoutCents: 0, chargedCents: 50_000, netCents: 50_000 });
    expect(JSON.stringify(blind)).not.toMatch(/177000|177500|6000\b|227|221/);
    const full = await c.metrics(user('OWNER'), 't-1');
    expect(full.today).toMatchObject({ walletCashTopUpCents: 177_000, walletCashPayoutCents: 6_000, chargedCents: 227_500, netCents: 221_500 });
    open = null;
    expect(await c.metrics(user('MANAGER'), 't-1')).toEqual(full);
  });

  it('GET /admin/export/*: con la noche abierta, la encargada no descarga lo de efectivo de un periodo que llegue a ella (409 «Se ve al cerrar la noche»)', async () => {
    let open: Date | null = openFrom;
    const reports = {
      openNightStart: async () => open,
      cobros: async () => [], devoluciones: async () => [], liquidaciones: async () => [], consumos: async () => [],
      pagosSaldo: async () => [], recargasEfectivo: async () => [], venueName: async () => 'Local', sectionLabeler: async () => () => '',
    };
    const c = new ReportsController(reports as never);
    const reply = () => {
      const r = { status: () => r, header: () => r, send: () => r };
      return r as never;
    };
    for (const kind of ['recargas-efectivo', 'saldo-devuelto', 'resumen', 'liquidaciones', 'devoluciones']) {
      const err = await c.export(user('MANAGER'), 't-1', kind, '2026-11-01', '2026-11-26', reply()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).message).toMatch(/Se ve al cerrar la noche/);
      await expect(c.export(user('OWNER'), 't-1', kind, '2026-11-01', '2026-11-26', reply())).resolves.toBeUndefined();
      // Un periodo que acaba antes de abrir la noche (hasta el 25 incluido): sí.
      await expect(c.export(user('MANAGER'), 't-1', kind, '2026-11-01', '2026-11-25', reply())).resolves.toBeUndefined();
    }
    // Los cobros (con tarjeta) no llevan efectivo de caja.
    await expect(c.export(user('MANAGER'), 't-1', 'cobros', '2026-11-01', '2026-11-26', reply())).resolves.toBeUndefined();
    open = null;
    await expect(c.export(user('MANAGER'), 't-1', 'resumen', '2026-11-01', '2026-11-26', reply())).resolves.toBeUndefined();
  });

  it('Saldos → las recargas y lo devuelto de esta noche, sin el efectivo para la encargada', async () => {
    const stats = {
      activeCount: 3, totalBalanceCents: 9_000, nightOpen: true, todayTopUpsCents: 227_000, todayConsumptionsCents: 10_000,
      todayRefundsCents: 6_500, todayCashTopUpsCents: 177_000, todayCashRefundsCents: 6_000, byCategory: {},
    };
    let open = true;
    const c = new AdminWalletsController(
      { getAdminStats: async () => stats } as never,
      { currentWindow: async () => ({ from: openFrom, open }) } as never,
    );
    const blind = await c.stats(user('MANAGER'));
    expect(blind).toMatchObject({ todayTopUpsCents: 50_000, todayRefundsCents: 500, cashHidden: true });
    expect(JSON.stringify(blind)).not.toMatch(/177000|227000|6000\b/);
    expect(await c.stats(user('OWNER'))).toEqual(stats);
    open = false;
    expect(await c.stats(user('MANAGER'))).toEqual(stats);
  });

  it('«Ver si cuadra»: la diferencia sí, lo esperado nunca (tampoco en el texto)', () => {
    const cash = { openingFloatCents: 20_000, cashInCents: 177_000, walletCashTopUpsCount: 1, walletCashTopUpsCents: 177_000, walletCashPayoutsCount: 0, walletCashPayoutsCents: 0, chicaCashPayoutsCount: 0, chicaCashPayoutsCents: 0, cashOutCents: 0, expectedCents: 197_000 };
    const short = blindCashCountResult(evaluateCash(cash, { countedCents: 190_000 }), 190_000);
    expect(short).toMatchObject({ reason: 'short', diffCents: -7_000 });
    const changed = blindCashCountResult(evaluateCash(cash, { countedCents: 190_000, openingFloatCents: 10_000 }), 190_000);
    expect(changed).toMatchObject({ reason: 'float-changed', diffCents: null });
    expect(changed.detail).not.toContain('200,00');
    const negative = blindCashCountResult(evaluateCash({ ...cash, cashInCents: 0, cashOutCents: 30_000 }, { countedCents: 0 }), 0);
    expect(negative).toMatchObject({ reason: 'negative', diffCents: null });
    expect(negative.detail).not.toMatch(/\d+,\d\d/);
  });
});
