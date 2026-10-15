import { describe, it, expect } from 'vitest';
import { EMPTY_TOTALS, type PeriodTotals } from './period-totals';
import { madridQuarter } from './reporting-window';
import { buildVat303, vatSplit } from './vat-303';

const VENUE = { name: 'Local Centro', vatBps: 2100, vatRegime: 'GENERAL' };
const NOW = new Date('2026-04-02T10:00:00Z');
const month = (o: Partial<PeriodTotals>): PeriodTotals => ({ ...EMPTY_TOTALS, ...o });

describe('IVA de un importe con IVA incluido', () => {
  it('121 € al 21 % → 100 € de base y 21 € de cuota', () => {
    expect(vatSplit(12_100, 2100)).toEqual({ baseCents: 10_000, cuotaCents: 2100 });
  });

  it('negativo (más devuelto que cobrado en el mes) → base y cuota negativas', () => {
    expect(vatSplit(-12_100, 2100)).toEqual({ baseCents: -10_000, cuotaCents: -2100 });
  });
});

describe('Modelo 303 del trimestre', () => {
  const q = madridQuarter('Q1-2026');

  it('propinas fuera de la base; devoluciones y saldo devuelto en efectivo restan', () => {
    const r = buildVat303({
      quarter: q,
      venue: VENUE,
      months: [
        // Enero: 121 € cobrados + 5 € de propina.
        month({ paymentCount: 1, grossCents: 12_100, tipCents: 500 }),
        // Febrero: 242 €; se devuelven 12,60 € (12,10 de importe + 0,50 de
        // propina) y 12,10 € de saldo en efectivo.
        month({
          paymentCount: 2,
          grossCents: 24_200,
          tipCents: 500,
          refundCount: 1,
          refundedCents: 1260,
          refundedTipCents: 50,
          walletCashPayoutCount: 1,
          walletCashPayoutCents: 1210,
        }),
        month({}),
      ],
      consumptions: { count: 4, cents: 9000 },
      now: NOW,
    });
    if ('exento' in r) throw new Error('no es exento');
    expect(r.byMonth.map((m) => [m.month, m.facturadoCents, m.baseImponibleCents, m.cuotaIvaCents])).toEqual([
      ['2026-01', 12_100, 10_000, 2100],
      ['2026-02', 21_780, 18_000, 3780],
      ['2026-03', 0, 0, 0],
    ]);
    expect(r.modelo303).toEqual({
      baseImponibleCents: 28_000,
      cuotaIvaCents: 5880,
      totalFacturadoCents: 33_880,
      ivaAIngresarCents: 5880,
    });
    // Lo cobrado de verdad sí lleva propinas: 363 + 10 − 12,60 − 12,10.
    expect(r.breakdown).toMatchObject({
      grossCents: 36_300,
      tipCents: 1000,
      refundedCents: 1260,
      refundedTipCents: 50,
      walletCashPayoutCents: 1210,
      netCobradoCents: 36_300 + 1000 - 1260 - 1210,
      facturadoCents: 33_880,
    });
    expect(r.walletInfo).toMatchObject({ consumptionCount: 4, consumptionCents: 9000 });
    expect(r.from).toBe('2025-12-31T23:00:00.000Z');
    expect(r.to).toBe('2026-03-31T22:00:00.000Z');
  });

  it('el trimestre es la suma de sus meses, céntimo a céntimo', () => {
    // 3 céntimos al mes: 2 de base + 1 de cuota. Redondeando el trimestre
    // entero saldrían 7 + 2; la suma de los meses da 6 + 3 (lo que se declara).
    const r = buildVat303({
      quarter: q,
      venue: VENUE,
      months: [month({ grossCents: 3 }), month({ grossCents: 3 }), month({ grossCents: 3 })],
      consumptions: { count: 0, cents: 0 },
      now: NOW,
    });
    if ('exento' in r) throw new Error('no es exento');
    const sum = (k: 'baseImponibleCents' | 'cuotaIvaCents') => r.byMonth.reduce((a, m) => a + m[k], 0);
    expect(r.modelo303.baseImponibleCents).toBe(sum('baseImponibleCents'));
    expect(r.modelo303.cuotaIvaCents).toBe(sum('cuotaIvaCents'));
    expect(r.modelo303).toMatchObject({ baseImponibleCents: 6, cuotaIvaCents: 3, totalFacturadoCents: 9 });
  });

  it('el saldo devuelto a la tarjeta (ya es devolución de la recarga) no resta otra vez', () => {
    const base = { quarter: q, venue: VENUE, consumptions: { count: 0, cents: 0 }, now: NOW };
    const recarga = month({ paymentCount: 1, grossCents: 20_000, refundCount: 1, refundedCents: 8000 });
    const conTarjeta = month({ ...recarga, walletCardPayoutCount: 1, walletCardPayoutCents: 8000 });
    const a = buildVat303({ ...base, months: [recarga, month({}), month({})] });
    const b = buildVat303({ ...base, months: [conTarjeta, month({}), month({})] });
    if ('exento' in a || 'exento' in b) throw new Error('no es exento');
    expect(b.modelo303).toEqual(a.modelo303);
    expect(b.breakdown.walletCardPayoutCents).toBe(8000);
  });

  it('régimen exento → sin cálculo', () => {
    const r = buildVat303({
      quarter: q,
      venue: { ...VENUE, vatRegime: 'EXENTO' },
      months: [month({ grossCents: 100 }), month({}), month({})],
      consumptions: { count: 0, cents: 0 },
      now: NOW,
    });
    expect(r).toMatchObject({ quarter: 'Q1-2026', exento: true });
  });
});
