import { describe, it, expect } from 'vitest';
import { EMPTY_TOTALS, type PeriodTotals } from './period-totals';
import { buildMetrics, buildPeriodZ, type ZCategoryRow, type ZGroupRow, type ZOperatorRow } from './period-reports';

const TOTALS: PeriodTotals = {
  paymentCount: 4,
  grossCents: 38_000,
  tipCents: 500,
  refundCount: 1,
  refundedCents: 2100,
  refundedTipCents: 100,
  walletCashPayoutCount: 1,
  walletCashPayoutCents: 8000,
  walletCardPayoutCount: 1,
  walletCardPayoutCents: 4000,
};

describe('métricas del panel (hoy y semana)', () => {
  it('neto con propinas y sin lo devuelto (también el saldo en efectivo); estados por número', () => {
    const m = buildMetrics({
      today: TOTALS,
      week: { ...TOTALS, paymentCount: 10, grossCents: 100_000 },
      statuses: [
        { status: 'AUTHORIZED', count: 3 },
        { status: 'REFUNDED', count: 1 },
        { status: 'FAILED', count: 2 },
      ],
    });
    expect(m.today).toEqual({
      count: 4,
      grossCents: 38_000,
      tipCents: 500,
      chargedCents: 38_500,
      refundedCents: 2100,
      walletCashPayoutCents: 8000,
      netCents: 38_500 - 2100 - 8000,
    });
    expect(m.week).toMatchObject({ count: 10, netCents: 100_500 - 2100 - 8000 });
    expect(m.statusBreakdown).toEqual({ AUTHORIZED: 3, REFUNDED: 1, FAILED: 2 });
  });
});

describe('Z de un periodo', () => {
  const groups: ZGroupRow[] = [
    { captureMethod: 'QR', provider: 'REDSYS', zone: 'BARRA', count: 2, grossCents: 13_000n, tipCents: 500n },
    // Cobros antiguos sin medio apuntado: eran QR.
    { captureMethod: null, provider: 'REDSYS', zone: null, count: 1, grossCents: 20_000n, tipCents: 0n },
    { captureMethod: 'POS_EXTERNAL', provider: null, zone: 'SALA', count: 1, grossCents: 5000n, tipCents: 0n },
  ];
  const categories: ZCategoryRow[] = [
    { source: 'CARD', category: 'CHICA_SERVICE', count: 1, grossCents: 10_000n, tipCents: 500n },
    { source: 'CARD', category: 'VENUE_BAR', count: 2, grossCents: 8000n, tipCents: 0n },
    { source: 'TOPUP', category: 'EXTRA', count: 1, grossCents: 20_000n, tipCents: 0n },
    { source: 'WALLET', category: 'CHICA_SERVICE', count: 1, grossCents: 6000n, tipCents: 1000n },
    { source: 'WALLET', category: 'VENUE_BAR', count: 3, grossCents: 6000n, tipCents: 0n },
  ];
  const op = (id: string, net: number): ZOperatorRow => ({
    operatorId: id,
    displayName: id.toUpperCase(),
    email: `${id}@local.es`,
    earningCount: 1,
    netCents: BigInt(net),
  });
  const operators = [op('a', 100), op('b', 900), op('c', 300), op('d', 500), op('e', 700), op('f', 200)];
  const z = buildPeriodZ({
    window: { from: new Date('2026-10-13T22:00:00Z'), to: new Date('2026-10-14T05:00:00Z') },
    totals: TOTALS,
    groups,
    categories,
    operators,
    operatorPayouts: { count: 1, totalCents: 50_000n },
    now: new Date('2026-10-14T05:00:00Z'),
  });

  it('resumen: cobrado, devoluciones y saldo devuelto en efectivo (el de tarjeta ya es devolución)', () => {
    expect(z.summary).toEqual({
      paymentCount: 4,
      grossCents: 38_000,
      tipCents: 500,
      chargedCents: 38_500,
      refundCount: 1,
      refundedCents: 2100,
      walletCashPayoutCount: 1,
      walletCashPayoutCents: 8000,
      netCents: 38_500 - 2100 - 8000,
    });
    expect(z.period).toEqual({ from: '2026-10-13T22:00:00.000Z', to: '2026-10-14T05:00:00.000Z' });
  });

  it('por medio, pasarela y zona (sin dato: QR, NONE, SIN_ZONA), de más a menos', () => {
    expect(z.byCaptureMethod).toEqual([
      { method: 'QR', count: 3, grossCents: 33_000, tipCents: 500 },
      { method: 'POS_EXTERNAL', count: 1, grossCents: 5000, tipCents: 0 },
    ]);
    expect(z.byProvider).toEqual([
      { provider: 'REDSYS', count: 3, grossCents: 33_000, tipCents: 500 },
      { provider: 'NONE', count: 1, grossCents: 5000, tipCents: 0 },
    ]);
    expect(z.byZone.map((r) => [r.zone, r.count, r.grossCents])).toEqual([
      ['SIN_ZONA', 1, 20_000],
      ['BARRA', 2, 13_000],
      ['SALA', 1, 5000],
    ]);
  });

  it('ventas por tipo: cobros con tarjeta + consumos del saldo; las recargas van aparte', () => {
    expect(z.byRevenueCategory).toEqual([
      {
        category: 'CHICA_SERVICE',
        count: 2,
        grossCents: 16_000,
        tipCents: 1500,
        paymentCount: 1,
        paymentCents: 10_000,
        consumptionCount: 1,
        consumptionCents: 6000,
      },
      {
        category: 'VENUE_BAR',
        count: 5,
        grossCents: 14_000,
        tipCents: 0,
        paymentCount: 2,
        paymentCents: 8000,
        consumptionCount: 3,
        consumptionCents: 6000,
      },
    ]);
    expect(z.chicaRevenue).toEqual({ count: 2, grossCents: 16_000 });
    expect(z.venueRevenue).toEqual({ count: 5, grossCents: 14_000 });
  });

  it('saldo: recargas, consumos y lo devuelto (efectivo y tarjeta)', () => {
    expect(z.wallet).toEqual({
      topUpCount: 1,
      topUpCents: 20_000,
      consumptionCount: 4,
      consumptionCents: 12_000,
      consumptionTipCents: 1000,
      cashPayoutCount: 1,
      cashPayoutCents: 8000,
      cardPayoutCount: 1,
      cardPayoutCents: 4000,
    });
  });

  it('chicas: las 5 primeras por neto y el total de todas; pagos hechos', () => {
    expect(z.topOperators.map((o) => o.operatorId)).toEqual(['b', 'e', 'd', 'c', 'f']);
    expect(z.topOperators[0]).toEqual({ operatorId: 'b', displayName: 'B', email: 'b@local.es', netCents: 900, earningCount: 1 });
    expect(z.earnings).toEqual({ count: 6, totalNetCents: 2700 });
    expect(z.payouts).toEqual({ count: 1, totalCents: 50_000 });
  });

  it('periodo vacío → ceros', () => {
    const empty = buildPeriodZ({
      window: { from: new Date('2026-10-13T22:00:00Z'), to: new Date('2026-10-14T05:00:00Z') },
      totals: EMPTY_TOTALS,
      groups: [],
      categories: [],
      operators: [],
      operatorPayouts: { count: 0, totalCents: null },
      now: new Date('2026-10-14T05:00:00Z'),
    });
    expect(empty.summary.netCents).toBe(0);
    expect(empty.byRevenueCategory).toEqual([]);
    expect(empty.payouts).toEqual({ count: 0, totalCents: 0 });
  });
});
