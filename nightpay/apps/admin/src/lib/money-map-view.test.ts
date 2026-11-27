import { describe, expect, it } from 'vitest';
import { DEFAULT_SECTIONS, SECTION_CODES, type MoneyMap, type VenueSection } from '@nightpay/contracts';
import { moneyMapDetails } from './money-map-details';
import * as view from './money-map-view';
import { barSegments, legendFlex, moneyMapView, railNote, sectionPaint } from './money-map-view';
import { formatEur } from './money';

const SECTIONS: VenueSection[] = SECTION_CODES.map((code) => ({ code, ...DEFAULT_SECTIONS[code] }));
/** Intl pone un espacio duro antes del €: aquí, uno normal. */
const sp = (s: string | null | undefined) => s?.replace(/\u00a0/g, ' ');
const eur = (cents: number) => sp(formatEur(cents));

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
  // Entrega 10 A: el panel, siempre con céntimos (antes, eurShort los quitaba si eran redondos).
  it('siempre con céntimos, con el punto de los miles; ya no hay eurShort', () => {
    expect(eur(530_000)).toBe('5.300,00 €');
    expect(eur(1_250)).toBe('12,50 €');
    expect(eur(0)).toBe('0,00 €');
    expect(eur(-7_000)).toBe('\u221270,00 €');
    expect('eurShort' in view).toBe(false);
  });
});

describe('colores de las secciones', () => {
  it('el de la marca (sectionColor) y el nombre del local; el del dueño si lo cambió', () => {
    expect(sectionPaint(SECTIONS, 'CHICA_SERVICE')).toEqual({ label: 'Servicios', color: '#ff77a2' });
    expect(sectionPaint(SECTIONS, 'TIPS')).toEqual({ label: 'Propinas', color: '#feee82' });
    expect(sectionPaint(SECTIONS, 'EXTRA')).toEqual({ label: 'Otros', color: '#7c8893' });
    const own = SECTIONS.map((s) => (s.code === 'VENUE_BAR' ? { ...s, label: 'Barra', color: '#123456' } : s));
    expect(sectionPaint(own, 'VENUE_BAR')).toEqual({ label: 'Barra', color: '#123456' });
  });

  it('un color guardado de fábrica antiguo no cuenta como cambiado: sale el vivo; el del dueño se respeta', () => {
    const old = SECTIONS.map((s) =>
      s.code === 'VENUE_BAR' ? { ...s, color: '#3fe0c0' } : s.code === 'CHICA_SERVICE' ? { ...s, color: '#DF73E4' } : s.code === 'VENUE_FOOD' ? { ...s, color: '#abcdef' } : s,
    );
    expect(sectionPaint(old, 'VENUE_BAR').color).toBe('#46efd4');
    expect(sectionPaint(old, 'CHICA_SERVICE').color).toBe('#ff77a2');
    expect(sectionPaint(old, 'VENUE_FOOD').color).toBe('#abcdef');
  });

  it('los vivos de Grafito guardados (de fábrica hasta «Color y relieve») también cuentan como de fábrica: sale el de hoy', () => {
    const grafito = SECTIONS.map((s) => (s.code === 'VENUE_BAR' ? { ...s, color: '#00e0ae' } : s.code === 'CHICA_SERVICE' ? { ...s, color: '#E447F0' } : s));
    expect(sectionPaint(grafito, 'VENUE_BAR').color).toBe('#46efd4');
    expect(sectionPaint(grafito, 'CHICA_SERVICE').color).toBe('#ff77a2');
  });
});

describe('maqueta 8 · A, barras apiladas', () => {
  it('KPIs, franja, cómo entra (con las recargas aparte) y por sección', () => {
    const v = moneyMapView(map(), SECTIONS);
    expect(v).toMatchObject({ salesLabel: 'Ventas de la noche', salesCents: 530_000, venueCents: 308_600, venuePct: 58 });
    // Las cuatro cifras de arriba en el escritorio (D8): ventas, para el local, propinas y cobros.
    expect(v).toMatchObject({ tipsCents: 12_000, salesCount: 80 });
    expect(moneyMapView(map({ sections: [] }), SECTIONS).tipsCents).toBe(0);
    expect(v.stripe.map((s) => s.key)).toEqual(['CHICA_SERVICE', 'VENUE_BAR', 'VENUE_ROOM', 'VENUE_FOOD', 'VENUE_ENTRY', 'TIPS']);
    expect(v.inflow.map((s) => [s.label, s.cents])).toEqual([
      ['Tarjeta', 180_000],
      ['Efectivo', 165_000],
      ['Del saldo', 185_000],
    ]);
    expect(v.topUps?.cents).toBe(307_000);
    expect(sp(v.topUps?.detail)).toBe('efectivo 1.070,00 € · tarjeta 2.000,00 €');
    expect(v.sections.map((s) => [s.label, s.pct])).toEqual([
      ['Servicios', 100],
      ['Copas', 58],
      ['Habitaciones', 33],
      ['Comida', 8],
      ['Entradas', 17],
      ['Propinas', 5],
    ]);
  });

  it('cómo entra: un canal a 0,00 € no sale (aquí el efectivo entra como recarga); sin ventas, ninguno', () => {
    const noCash = moneyMapView(map({ inflow: { ...map().inflow, cashCents: 0 } }), SECTIONS);
    expect(noCash.inflow.map((s) => s.key)).toEqual(['card', 'saldo']);
    const onlyCash = moneyMapView(
      map({ inflow: { ...map().inflow, cardRailCents: 0, saldoCents: 0, topUps: { totalCents: 5_000, cardCents: 0, cashCents: 5_000, count: 1 } } }),
      SECTIONS,
    );
    expect(onlyCash.inflow.map((s) => s.key)).toEqual(['cash']);
    expect(sp(onlyCash.topUps?.detail)).toBe('efectivo 50,00 €');
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
      ['De compañeras', 216_000],
      ['Saldo nuevo de clientes (estas fechas)', 115_000],
    ]);
    expect(v.where.note).toBeNull();
    expect(v.outflow.map((r) => [r.label, r.note, r.cents])).toEqual([
      ['Pago a compañeras', 'al cerrar', 216_000],
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
      'Pago a compañeras · transferencia',
      'Pago a camareros · efectivo',
      'Pago a camareros · al cerrar',
      'Devoluciones · tarjeta',
      'Comisiones · banco y OxioPay',
    ]);
    expect(v.where.owners[1]!.label).toBe('De camareros');
    // Cómo se reparte: cada uno con su importe; las comisiones, con su propio gris (no el del saldo).
    expect(v.split.map((x) => [x.label, x.cents])).toEqual([['Local', 1], ['Personal', 601], ['Comisiones', 150]]);
    expect(v.split.find((x) => x.key === 'fees')?.color).toBe('var(--np-mm-comision)');
    expect(v.split.map((x) => x.color)).not.toContain('var(--np-mm-saldo)');
    expect(sp(v.where.note)).toBe('Deuda total al personal ahora: 7,00 €');
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
    expect(v.where.owners.find((r) => r.key === 'saldo')).toMatchObject({ label: 'Saldo nuevo de clientes (estas fechas)', cents: -5000 });
    expect(v.where.balance).toEqual({ label: 'Saldo real de clientes ahora', cents: 235000 });
  });
  it('un Z antiguo etiqueta el saldo y la deuda al corte y no los presenta como actuales', () => {
    const m = map({ scope: { kind: 'night', nightId: 'old', open: false }, frozen: true,
      where: { ...map().where, liveSaldoCents: 999000, owed: { chicasCents: 300000, camarerosCents: 0 } } });
    const v = moneyMapView(m, SECTIONS);
    expect(v.where.balance.label).toBe('Saldo real de clientes al corte');
    expect(v.where.note).not.toContain('ahora');
    expect(v.where.note).toContain('al corte');
    expect(moneyMapDetails(m).owed.rows.at(-1)?.label).toContain('al corte');
  });
  it('un periodo sin saldo histórico disponible conserva el desconocido', () => {
    const v = moneyMapView(map({ scope: { kind: 'period' }, where: { ...map().where, liveSaldoCents: null } }), SECTIONS);
    expect(v.where.balance).toEqual({ label: 'Saldo real de clientes al corte', cents: null });
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
    expect(d.outflow.rows[0]).toEqual({ label: 'Pagado a compañeras · efectivo', cents: 45000, count: 2 });
  });
});

describe('con la «Comisión del servicio» (la paga el cliente, se debe a OxioPay)', () => {
  // 66 € de comisión en ventas con tarjeta, 120 € en recargas (60 € en efectivo), 10 € devueltos.
  const withFee = () =>
    map({
      inflow: { ...map().inflow, serviceFeeCents: 18_600 },
      where: { ...map().where, owners: { venueCents: 308_600 - 17_600, staffCents: 216_000, saldoCents: 115_000, oxioPayCents: 17_600 } },
      outflow: { ...map().outflow, serviceFeeCents: 17_600 },
      serviceFee: { salesCents: 6_600, topUpsCents: 12_000, cashCents: 6_000, refundedCents: 1_000, owedCents: 17_600 },
    });

  it('cómo entra: la comisión, aparte (no es venta) y de quién es', () => {
    const v = moneyMapView(withFee(), SECTIONS);
    expect(v.serviceFee).toEqual({ cents: 18_600, detail: expect.any(String) });
    expect(sp(v.serviceFee!.detail)).toBe('cobros 66,00 € · recargas 120,00 €');
  });

  it('dónde está: una parte es de OxioPay; y sale lo que se le debe', () => {
    const v = moneyMapView(withFee(), SECTIONS);
    expect(v.where.owners.find((s) => s.key === 'oxiopay')).toMatchObject({ label: 'De OxioPay (comisión del servicio)', cents: 17_600 });
    expect(v.where.owners.reduce((a, s) => a + s.cents, 0)).toBe(v.where.totalCents);
    expect(v.outflow.find((r) => r.key === 'service-fee')).toEqual({ key: 'service-fee', label: 'Comisión del servicio', note: 'se debe a OxioPay', cents: 17_600 });
  });

  it('el desglose: cobrada, devuelta y lo que se debe', () => {
    const d = moneyMapDetails(withFee());
    expect(d.serviceFee!.rows).toEqual([
      { label: 'En cobros con tarjeta o datáfono', cents: 6_600 },
      { label: 'En recargas del saldo', cents: 12_000 },
      { label: '…de ellas, en efectivo (está en la caja)', cents: 6_000 },
      { label: 'Devuelta con las devoluciones', cents: -1_000 },
      { label: 'Se debe a OxioPay', cents: 17_600 },
    ]);
  });

  it('sin ella (o un mapa de antes): nada de esto', () => {
    const v = moneyMapView(map(), SECTIONS);
    expect(v.serviceFee).toBeNull();
    expect(v.where.owners.map((s) => s.key)).toEqual(['venue', 'staff', 'saldo']);
    expect(v.outflow.map((r) => r.key)).not.toContain('service-fee');
    expect(moneyMapDetails(map()).serviceFee).toBeNull();
  });
});

describe('mapa del dinero con bitcoin (BTCPay)', () => {
  const withBitcoin = (): MoneyMap => {
    const m = map();
    return {
      ...m,
      salesCents: m.salesCents + 50_000,
      inflow: { ...m.inflow, bitcoinCents: 50_000, topUps: { ...m.inflow.topUps, bitcoinCents: 10_000 } },
      where: { ...m.where, bitcoinCents: 60_000, totalCents: m.where.totalCents + 60_000 },
    };
  };

  it('«Bitcoin» es un canal más de lo que entra y una línea nueva en dónde está el dinero', () => {
    const v = moneyMapView(withBitcoin(), SECTIONS);
    expect(v.inflow.find((s) => s.key === 'bitcoin')).toMatchObject({ label: 'Bitcoin', cents: 50_000 });
    expect(v.where.places.find((p) => p.key === 'bitcoin')).toMatchObject({ label: 'Bitcoin, en la cartera del local', cents: 60_000 });
    expect(v.where.places.find((p) => p.key === 'bbva')?.cents).toBe(map().where.bbvaCents);
  });

  it('sin bitcoin no sale ni el canal ni la línea', () => {
    const v = moneyMapView(map(), SECTIONS);
    expect(v.inflow.some((s) => s.key === 'bitcoin')).toBe(false);
    expect(v.where.places.some((p) => p.key === 'bitcoin')).toBe(false);
  });

  it('el detalle de caja y banco enseña la línea de bitcoin solo si la hay', () => {
    const rows = (m: MoneyMap) => moneyMapDetails(m).cash.rows.map((r) => r.label);
    expect(rows(withBitcoin())).toContain('Bitcoin, en la cartera del local');
    expect(rows(map())).not.toContain('Bitcoin, en la cartera del local');
  });
});

describe('«En cajeros de otras plataformas» (API de socios, PR 3 B)', () => {
  const withPartners = (cents: number): MoneyMap => {
    const m = map();
    return { ...m, where: { ...m.where, partnerCashCents: cents, totalCents: m.where.totalCents + cents } };
  };
  const LABEL = 'En cajeros de otras plataformas';

  it('una línea más en dónde está el dinero, con el color del efectivo, solo si viene el campo', () => {
    const v = moneyMapView(withPartners(9_000), SECTIONS);
    expect(v.where.places.find((p) => p.label === LABEL)).toMatchObject({ cents: 9_000, color: 'var(--np-mm-efectivo)' });
    expect(moneyMapView(map(), SECTIONS).where.places.some((p) => p.label === LABEL)).toBe(false);
  });

  it('la caja esperada no cambia (es lo del cajón de recepción)', () => {
    const v = moneyMapView(withPartners(9_000), SECTIONS);
    expect(v.where.places.find((p) => p.key === 'cash')).toMatchObject({ label: 'Caja esperada', cents: map().where.cashBoxCents });
  });

  it('también en negativo (una noche con solo una anulación del panel)', () => {
    expect(moneyMapView(withPartners(-3_000), SECTIONS).where.places.find((p) => p.label === LABEL)?.cents).toBe(-3_000);
  });

  it('el detalle de caja y banco la enseña solo si viene', () => {
    const rows = (m: MoneyMap) => moneyMapDetails(m).cash.rows;
    expect(rows(withPartners(9_000)).find((r) => r.label === LABEL)?.cents).toBe(9_000);
    expect(rows(map()).some((r) => r.label === LABEL)).toBe(false);
  });
});
