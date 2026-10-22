import { describe, expect, it } from 'vitest';
import { DEFAULT_SECTIONS, SECTION_CODES, type MoneyMap, type VenueSection } from '@nightpay/contracts';
import { moneyMapDetails } from './money-map-details';
import { barSegments, eurShort, legendFlex, moneyMapView, railNote, sectionPaint } from './money-map-view';

const SECTIONS: VenueSection[] = SECTION_CODES.map((code) => ({ code, ...DEFAULT_SECTIONS[code] }));
/** Intl pone un espacio duro antes del €: aquí, uno normal. */
const sp = (s: string | null | undefined) => s?.replace(/\u00a0/g, ' ');
const eur = (cents: number) => sp(eurShort(cents));

/** La noche de la maqueta 8 (cifras inventadas). */
function map(o: Partial<MoneyMap> = {}): MoneyMap {
  return {
    scope: { kind: 'night', nightId: 'n1', open: true },
    from: '2026-10-24T20:00:00.000Z',
    to: '2026-10-25T01:40:00.000Z',
    generatedAt: '2026-10-25T01:40:00.000Z',
    frozen: false,
    salesCents: 530_000,
    salesCount: 80,
    inflow: {
      cardRailCents: 180_000,
      cardCents: 120_000,
      mobileWalletCents: 40_000,
      posCents: 20_000,
      cashCents: 165_000,
      saldoCents: 185_000,
      topUps: { totalCents: 307_000, cardCents: 200_000, cashCents: 107_000, count: 30 },
    },
    sections: [
      { code: 'CHICA_SERVICE', amountCents: 240_000, count: 20 },
      { code: 'VENUE_BAR', amountCents: 139_000, count: 40 },
      { code: 'VENUE_ROOM', amountCents: 80_000, count: 10 },
      { code: 'VENUE_FOOD', amountCents: 19_000, count: 5 },
      { code: 'VENUE_ENTRY', amountCents: 40_000, count: 30 },
      { code: 'TIPS', amountCents: 12_000, count: 9 },
    ],
    split: { venueCents: 308_600, chicasCents: 216_000, camarerosCents: 0, commissions: { platformCents: 5_400, bankCents: null, totalCents: 5_400 } },
    where: {
      bbvaCents: 351_600,
      cashBoxCents: 288_000,
      cashBox: { openingFloatCents: 20_000, inCents: 107_000, outCents: 7_000 },
      totalCents: 639_600,
      owners: { venueCents: 308_600, staffCents: 216_000, saldoCents: 115_000 },
      liveSaldoCents: 115_000,
      owed: { chicasCents: 216_000, camarerosCents: 0 },
    },
    outflow: {
      payouts: [],
      pendingStaff: { chicasCents: 216_000, camarerosCents: 0 },
      refunds: { cardCents: 0, cardCount: 0, cashCents: 7_000, cashCount: 1 },
      commissionsCents: 5_400,
    },
    ...o,
  };
}

describe('importes del mapa', () => {
  it('sin céntimos si son redondos, con el punto de los miles', () => {
    expect(eur(530_000)).toBe('5.300 €');
    expect(eur(1_250)).toBe('12,50 €');
    expect(eur(0)).toBe('0 €');
    expect(eur(-7_000)).toBe('-70 €');
  });
});

describe('colores de las secciones', () => {
  it('el de la marca (sectionColor) y el nombre del local; el del dueño si lo cambió', () => {
    expect(sectionPaint(SECTIONS, 'CHICA_SERVICE')).toEqual({ label: 'Servicios', color: '#d24fd8' });
    expect(sectionPaint(SECTIONS, 'TIPS')).toEqual({ label: 'Propinas', color: '#3fa9f5' });
    expect(sectionPaint(SECTIONS, 'EXTRA')).toEqual({ label: 'Otros', color: '#7c8893' });
    const own = SECTIONS.map((s) => (s.code === 'VENUE_BAR' ? { ...s, label: 'Barra', color: '#123456' } : s));
    expect(sectionPaint(own, 'VENUE_BAR')).toEqual({ label: 'Barra', color: '#123456' });
  });
});

describe('maqueta 8 · A, barras apiladas', () => {
  it('KPIs, franja, cómo entra (con las recargas aparte) y por sección', () => {
    const v = moneyMapView(map(), SECTIONS);
    expect(v).toMatchObject({ salesLabel: 'Ventas de la noche', salesCents: 530_000, venueCents: 308_600, venuePct: 58 });
    expect(v.stripe.map((s) => s.key)).toEqual(['CHICA_SERVICE', 'VENUE_BAR', 'VENUE_ROOM', 'VENUE_FOOD', 'VENUE_ENTRY', 'TIPS']);
    expect(v.inflow.map((s) => [s.label, s.cents])).toEqual([
      ['Tarjeta', 180_000],
      ['Efectivo', 165_000],
      ['Del saldo', 185_000],
    ]);
    expect(v.topUps?.cents).toBe(307_000);
    expect(sp(v.topUps?.detail)).toBe('efectivo 1.070 € · tarjeta 2.000 €');
    expect(v.sections.map((s) => [s.label, s.pct])).toEqual([
      ['Servicios', 100],
      ['Copas', 58],
      ['Habitaciones', 33],
      ['Comida', 8],
      ['Entradas', 17],
      ['Propinas', 5],
    ]);
  });

  it('cómo entra: un canal a 0 € no sale (aquí el efectivo entra como recarga); sin ventas, ninguno', () => {
    const noCash = moneyMapView(map({ inflow: { ...map().inflow, cashCents: 0 } }), SECTIONS);
    expect(noCash.inflow.map((s) => s.key)).toEqual(['card', 'saldo']);
    const onlyCash = moneyMapView(
      map({ inflow: { ...map().inflow, cardRailCents: 0, saldoCents: 0, topUps: { totalCents: 5_000, cardCents: 0, cashCents: 5_000, count: 1 } } }),
      SECTIONS,
    );
    expect(onlyCash.inflow.map((s) => s.key)).toEqual(['cash']);
    expect(sp(onlyCash.topUps?.detail)).toBe('efectivo 50 €');
    const none = moneyMapView(map({ inflow: { ...map().inflow, cardRailCents: 0, cashCents: 0, saldoCents: 0 } }), SECTIONS);
    expect(none.inflow).toEqual([]);
  });

  it('dónde está (por sitio y por dueño) y qué sale', () => {
    const v = moneyMapView(map(), SECTIONS);
    expect(v.where.places.map((s) => [s.label, s.cents])).toEqual([
      ['Banco', 351_600],
      ['Caja esperada', 288_000],
    ]);
    expect(v.where.owners.map((s) => [s.label, s.cents])).toEqual([
      ['Tuyo', 308_600],
      ['De chicas', 216_000],
      ['Variación de saldo', 115_000],
    ]);
    expect(v.where.note).toBeNull();
    expect(v.outflow.map((r) => [r.label, r.note, r.cents])).toEqual([
      ['Pago a chicas', 'al cerrar', 216_000],
      ['Devoluciones', 'efectivo', 7_000],
      ['Comisiones', 'OxioPay (el banco, en su extracto)', 5_400],
    ]);
  });

  it('pagos hechos por vía, camareros, devoluciones a la tarjeta y comisión del banco', () => {
    const v = moneyMapView(
      map({
        split: { venueCents: 1, chicasCents: 1, camarerosCents: 600, commissions: { platformCents: 100, bankCents: 50, totalCents: 150 } },
        where: { ...map().where, owners: { venueCents: 1, staffCents: 600, saldoCents: 0 }, liveSaldoCents: 900, owed: { chicasCents: 100, camarerosCents: 600 } },
        outflow: {
          payouts: [
            { who: 'chicas', rail: 'SEPA_IBAN', count: 1, cents: 4_000 },
            { who: 'camareros', rail: 'MANUAL_CASH', count: 1, cents: 600 },
          ],
          pendingStaff: { chicasCents: 0, camarerosCents: 600 },
          refunds: { cardCents: 1_000, cardCount: 1, cashCents: 0, cashCount: 0 },
          commissionsCents: 150,
        },
      }),
      SECTIONS,
    );
    expect(v.outflow.map((r) => `${r.label} · ${r.note}`)).toEqual([
      'Pago a chicas · transferencia',
      'Pago a camareros · efectivo',
      'Pago a camareros · al cerrar',
      'Devoluciones · tarjeta',
      'Comisiones · banco y OxioPay',
    ]);
    expect(v.where.owners[1]!.label).toBe('De camareros');
    expect(sp(v.where.note)).toBe('Deuda total al personal ahora: 7 €');
  });

  it('un periodo, sin recargas y con una sección apagada sin ventas: no sale', () => {
    const off = SECTIONS.map((s) => (s.code === 'VENUE_FOOD' ? { ...s, enabled: false } : s));
    const v = moneyMapView(
      map({
        scope: { kind: 'period' },
        inflow: { ...map().inflow, topUps: { totalCents: 0, cardCents: 0, cashCents: 0, count: 0 } },
        sections: map().sections.map((s) => (s.code === 'VENUE_FOOD' ? { ...s, amountCents: 0 } : s)),
      }),
      off,
    );
    expect(v.salesLabel).toBe('Ventas del periodo');
    expect(v.topUps).toBeNull();
    expect(v.sections.map((s) => s.key)).not.toContain('VENUE_FOOD');
  });

  it('las barras: solo lo que tiene importe; la leyenda, con un ancho mínimo', () => {
    expect(barSegments([{ key: 'a', label: 'A', cents: 0, color: 'x' }, { key: 'b', label: 'B', cents: -5, color: 'x' }, { key: 'c', label: 'C', cents: 3, color: 'x' }]).map((s) => s.key)).toEqual(['c']);
    expect(legendFlex(0, 1000)).toBe(180);
    expect(legendFlex(900, 1000)).toBe(900);
    expect(legendFlex(0, 0)).toBe(1);
  });

  it('la vía de un pago al personal', () => {
    expect([railNote('MANUAL_CASH'), railNote('SEPA_IBAN'), railNote('USDT_TRC20'), railNote('REVOLUT_TAG'), railNote(null)]).toEqual([
      'efectivo',
      'transferencia',
      'cripto',
      'cuenta',
      'sin decir cómo',
    ]);
  });
});


describe('desgloses ampliados', () => {
  it('distingue la variación negativa del periodo del saldo real de los clientes', () => {
    const m = map({ where: { ...map().where, owners: { ...map().where.owners, saldoCents: -5000 }, liveSaldoCents: 235000 } });
    const v = moneyMapView(m, SECTIONS);
    expect(v.where.owners.find((r) => r.key === 'saldo')).toMatchObject({ label: 'Variación de saldo', cents: -5000 });
    expect(v.where.balance).toEqual({ label: 'Saldo total de clientes ahora', cents: 235000 });
  });
  it('un Z antiguo etiqueta el saldo y la deuda al corte y no los presenta como actuales', () => {
    const m = map({ scope: { kind: 'night', nightId: 'old', open: false }, frozen: true,
      where: { ...map().where, liveSaldoCents: 999000, owed: { chicasCents: 300000, camarerosCents: 0 } } });
    const v = moneyMapView(m, SECTIONS);
    expect(v.where.balance.label).toBe('Saldo total de clientes al corte');
    expect(v.where.note).not.toContain('ahora');
    expect(v.where.note).toContain('al corte');
    expect(moneyMapDetails(m).owed.rows.at(-1)?.label).toContain('al corte');
  });
  it('un periodo sin saldo histórico disponible conserva el desconocido', () => {
    const v = moneyMapView(map({ scope: { kind: 'period' }, where: { ...map().where, liveSaldoCents: null } }), SECTIONS);
    expect(v.where.balance).toEqual({ label: 'Saldo total de clientes al corte', cents: null });
  });
  it('los pendientes de un periodo o un Z recalculado se etiquetan al corte', () => {
    for (const scope of [{ kind: 'period' } as const, { kind: 'night', nightId: 'old', open: false } as const]) {
      const v = moneyMapView(map({ scope }), SECTIONS);
      expect(v.outflow.find((r) => r.key === 'pending-chicas')?.note).toBe('pendiente al corte');
    }
  });
  it('separa ventas, recargas, reparto y pagos realizados de los pendientes', () => {
    const d = moneyMapDetails(map());
    expect(d.inflow.rows.map((r) => r.cents)).toEqual([120000, 40000, 20000, 165000, 185000]);
    expect(d.topUps.rows[0]).toMatchObject({ cents: 307000, count: 30 });
    expect(d.split.rows.map((r) => r.cents)).toEqual([308600, 216000, 0, 5400, null]);
    expect(d.owed.rows[0]!.cents).toBe(216000);
    expect(d.outflow.rows.find((r) => r.label === 'Devuelto en efectivo')).toMatchObject({ cents: 7000, count: 1 });
    expect(d.outflow.rows.some((r) => r.label.includes('Pagado'))).toBe(false);
  });
  it('no inventa saldos históricos ni el fondo inicial; conserva negativos', () => {
    const m = map({ scope: { kind: 'period' }, where: { ...map().where, liveSaldoCents: null, owed: null, cashBox: { openingFloatCents: null, inCents: 500, outCents: 900 }, cashBoxCents: -400 } });
    const d = moneyMapDetails(m);
    expect(d.cash.rows[0]!.cents).toBeNull();
    expect(d.cash.rows[3]!.cents).toBe(-400);
    expect(d.owed.rows.slice(2, 4).map((r) => r.cents)).toEqual([null, null]);
    expect(d.owed.rows.at(-1)!.cents).toBeNull();
  });
  it('indica que una noche cerrada es histórica y cuenta los pagos por vía', () => {
    const m = map({ frozen: true, outflow: { ...map().outflow, payouts: [{ who: 'chicas', rail: 'MANUAL_CASH', count: 2, cents: 45000 }] } });
    const d = moneyMapDetails(m);
    expect(d.owed.note).toContain('al cerrar');
    expect(d.owed.rows[2]!.label).toContain('al corte');
    expect(d.outflow.rows[0]).toEqual({ label: 'Pagado a chicas · efectivo', cents: 45000, count: 2 });
  });
});
