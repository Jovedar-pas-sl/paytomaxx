import { describe, expect, it } from 'vitest';
import type { MoneyMap } from '@nightpay/contracts';
import { blindMoneyMap, blindNightView, blindsCash } from './blind-cash';
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
    where: { bbvaCents: 100_000, cashBoxCents: 191_000, cashBox: { openingFloatCents: 20_000, inCents: 177_000, outCents: 6_000 }, totalCents: 291_000 },
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

  it('GET /admin/money-map: en directo, a la encargada no le llega la caja esperada; una noche cerrada o unas fechas, sí', async () => {
    let m = map();
    const c = new MoneyMapController({ forQuery: async () => m } as never, {} as never);
    expect((await c.get(user('MANAGER'), {})).where.cashBoxCents).toBe(0);
    expect((await c.get(user('OWNER'), {})).where.cashBoxCents).toBe(191_000);
    m = { ...map(), scope: { kind: 'night', nightId: 'n-0', open: false } };
    expect((await c.get(user('MANAGER'), { night: 'n-0' })).where.cashBoxCents).toBe(191_000);
  });
});
