import { describe, expect, it } from 'vitest';
import { emptyConceptAmounts, type SettlementConceptAmounts } from '@nightpay/contracts';
import {
  adjustmentLines,
  breakdownOf,
  daysOpen,
  isOverdue,
  ledgerOf,
  periodNights,
  sameConcepts,
  settlementTotals,
  type StoredBreakdown,
} from './settlement-rules';
import { nightsOf, weekStartingOn } from './settlement-week';

const T = (iso: string) => new Date(iso);
const c = (o: Partial<SettlementConceptAmounts>): SettlementConceptAmounts => ({ ...emptyConceptAmounts(), ...o });
const WEEK44 = weekStartingOn('2026-10-26');
const WEEK43 = weekStartingOn('2026-10-19');

/** Una liquidación guardada de la semana 43 con 10 € de comisión del servicio el viernes y 2 € de plataforma el sábado. */
function stored43(): StoredBreakdown {
  return {
    version: 1,
    party: { venueName: 'Luna', venueSlug: 'luna', businessName: null, businessTaxId: null },
    platformBps: 1000,
    nights: nightsOf(WEEK43).map((n) => ({
      day: n.day,
      from: n.from.toISOString(),
      to: n.to.toISOString(),
      concepts: n.day === '2026-10-23' ? c({ serviceFeeSales: 1_000 }) : n.day === '2026-10-24' ? c({ platformSaldo: 200 }) : c({}),
    })),
    adjustments: [],
  };
}

describe('lo ya liquidado (libro): por noche y concepto, de las no anuladas', () => {
  it('suma las noches y los ajustes de varias liquidaciones', () => {
    const later: StoredBreakdown = {
      ...stored43(),
      nights: [],
      adjustments: [
        { weekFrom: '2026-10-19', isoYear: 2026, isoWeek: 43, reference: 'OXP-2026-S43-LUNA', day: '2026-10-23', concept: 'serviceFeeRefunded', amountCents: -95 },
      ],
    };
    const ledger = ledgerOf([stored43(), later]);
    expect(ledger.get('2026-10-23')).toEqual(c({ serviceFeeSales: 1_000, serviceFeeRefunded: -95 }));
    expect(ledger.get('2026-10-24')).toEqual(c({ platformSaldo: 200 }));
    expect(ledger.get('2026-10-26')).toBeUndefined();
  });
});

describe('la semana: lo de cada noche (el mapa del dinero) menos lo ya liquidado', () => {
  it('primera vez: las 7 noches tal cual (lo que da el mapa)', () => {
    const computed = nightsOf(WEEK44).map((n, i) => ({ ...n, concepts: c({ serviceFeeSales: i * 100 }) }));
    const nights = periodNights(computed, new Map());
    expect(nights).toHaveLength(7);
    expect(nights.map((n) => n.totalCents)).toEqual([0, 100, 200, 300, 400, 500, 600]);
    expect(nights[0]).toMatchObject({ day: '2026-10-26', from: '2026-10-26T07:00:00.000Z', to: '2026-10-27T07:00:00.000Z' });
  });

  it('regenerada con parte ya cobrada en otra (ajuste de una semana posterior): solo lo que falta', () => {
    const computed = nightsOf(WEEK43).map((n) => ({ ...n, concepts: n.day === '2026-10-23' ? c({ serviceFeeSales: 1_000 }) : c({}) }));
    const ledger = new Map([['2026-10-23', c({ serviceFeeSales: 400 })]]);
    const fri = periodNights(computed, ledger).find((n) => n.day === '2026-10-23')!;
    expect(fri.concepts.serviceFeeSales).toBe(600);
  });
});

describe('ajustes de semanas anteriores: lo apuntado tarde, con su detalle', () => {
  it('una devolución del banco con fecha del viernes de la 43, apuntada después de liquidarla: −0,95 € en esa noche', () => {
    const ledger = ledgerOf([stored43()]);
    const recomputed = nightsOf(WEEK43).map((n) => ({
      day: n.day,
      concepts:
        n.day === '2026-10-23'
          ? c({ serviceFeeSales: 1_000, serviceFeeRefunded: -95 })
          : n.day === '2026-10-24'
            ? c({ platformSaldo: 200 })
            : c({}),
    }));
    const lines = adjustmentLines([{ week: WEEK43, reference: 'OXP-2026-S43-LUNA', nights: recomputed }], ledger);
    expect(lines).toEqual([
      { weekFrom: '2026-10-19', isoYear: 2026, isoWeek: 43, reference: 'OXP-2026-S43-LUNA', day: '2026-10-23', concept: 'serviceFeeRefunded', amountCents: -95 },
    ]);
  });

  it('una semana sin liquidar (salió a 0 o se anuló): entra entera; si ya cuadra, nada', () => {
    const lines = adjustmentLines(
      [{ week: WEEK43, reference: null, nights: [{ day: '2026-10-20', concepts: c({ platformSales: 300, serviceFeeCashTopUps: 120 }) }] }],
      new Map(),
    );
    expect(lines.map((l) => [l.concept, l.amountCents])).toEqual([
      ['serviceFeeCashTopUps', 120],
      ['platformSales', 300],
    ]);
    expect(adjustmentLines([{ week: WEEK43, reference: 'x', nights: stored43().nights }], ledgerOf([stored43()]))).toEqual([]);
  });
});

describe('totales', () => {
  it('semana + ajustes, por concepto; el total es su suma', () => {
    const nights = periodNights(
      nightsOf(WEEK44).map((n) => ({ ...n, concepts: n.day === '2026-10-30' ? c({ serviceFeeSales: 2_000, serviceFeeRefunded: -100 }) : c({}) })),
      new Map(),
    );
    const adjustments = [
      { weekFrom: '2026-10-19', isoYear: 2026, isoWeek: 43, reference: null, day: '2026-10-23', concept: 'serviceFeeRefunded' as const, amountCents: -95 },
    ];
    const t = settlementTotals(nights, adjustments);
    expect(t).toEqual({ periodCents: 1_900, adjustmentsCents: -95, totalCents: 1_805, byConcept: c({ serviceFeeSales: 2_000, serviceFeeRefunded: -195 }) });
  });

  it('sameConcepts: iguales concepto a concepto', () => {
    expect(sameConcepts(c({ platformSales: 1 }), c({ platformSales: 1 }))).toBe(true);
    expect(sameConcepts(c({ platformSales: 1 }), c({ platformSaldo: 1 }))).toBe(false);
  });

  it('breakdownOf lee lo guardado (y rechaza lo que no lo es)', () => {
    expect(breakdownOf(stored43())).toEqual(stored43());
    expect(() => breakdownOf({ version: 2 })).toThrow();
  });
});

describe('sin pagar: días y aviso a los 7', () => {
  it('días desde que se emitió; abierta y más de 7 días → con aviso', () => {
    const generatedAt = T('2026-11-02T09:00:00Z');
    expect(daysOpen(generatedAt, T('2026-11-09T08:59:00Z'))).toBe(6);
    expect(isOverdue({ status: 'ISSUED', generatedAt }, T('2026-11-09T09:00:00Z'))).toBe(false);
    expect(isOverdue({ status: 'ISSUED', generatedAt }, T('2026-11-09T09:00:01Z'))).toBe(true);
    expect(isOverdue({ status: 'PARTIALLY_PAID', generatedAt }, T('2026-11-20T00:00:00Z'))).toBe(true);
    expect(isOverdue({ status: 'PAID', generatedAt }, T('2026-11-20T00:00:00Z'))).toBe(false);
    expect(isOverdue({ status: 'VOID', generatedAt }, T('2026-11-20T00:00:00Z'))).toBe(false);
  });
});
