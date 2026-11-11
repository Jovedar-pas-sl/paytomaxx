import { describe, expect, it } from 'vitest';
import { DEFAULT_SECTIONS, SECTION_CODES, type MoneyMap, type VenueSection } from '@nightpay/contracts';
import { moneyMapQuestions } from './money-map-questions';

const SECTIONS: VenueSection[] = SECTION_CODES.map((code) => ({ code, ...DEFAULT_SECTIONS[code] }));
const sp = (s: string) => s.replaceAll(String.fromCharCode(0xa0), ' ');

/** Una noche abierta con cifras inventadas (la de la maqueta 8, ampliada). */
function map(o: Partial<MoneyMap> = {}): MoneyMap {
  return {
    scope: { kind: 'night', nightId: 'n1', open: true },
    from: '2026-10-24T20:00:00.000Z',
    to: '2026-10-25T01:40:00.000Z',
    generatedAt: '2026-10-25T01:40:00.000Z',
    frozen: false,
    salesCents: 97_700,
    salesCount: 40,
    inflow: {
      cardRailCents: 68_200,
      cardCents: 50_000,
      mobileWalletCents: 10_000,
      posCents: 8_200,
      cashCents: 50_000,
      saldoCents: 0,
      topUps: { totalCents: 60_000, cardCents: 20_000, cashCents: 40_000, count: 5 },
    },
    sections: [
      { code: 'VENUE_BAR', amountCents: 52_000, count: 20 },
      { code: 'VENUE_FOOD', amountCents: 15_700, count: 8 },
      { code: 'VENUE_ENTRY', amountCents: 30_000, count: 12 },
    ],
    split: { venueCents: 76_300, chicasCents: 10_700, camarerosCents: 0, commissions: { platformCents: 10_700, bankCents: 0, totalCents: 10_700 } },
    where: {
      bbvaCents: 68_200,
      cashBoxCents: 50_000,
      cashBox: { openingFloatCents: 10_000, inCents: 45_000, outCents: 5_000 },
      totalCents: 118_200,
      owners: { venueCents: 76_300, staffCents: 10_700, saldoCents: 21_700 },
      liveSaldoCents: 21_700,
      owed: { chicasCents: 10_700, camarerosCents: 0 },
    },
    outflow: {
      payouts: [],
      pendingStaff: { chicasCents: 9_000, camarerosCents: 0 },
      refunds: { cardCents: 1_200, cardCount: 1, cashCents: 0, cashCount: 0 },
      commissionsCents: 10_700,
    },
    ...o,
  };
}

const card = (m: MoneyMap, key: string) => moneyMapQuestions(m, SECTIONS).cards.find((c) => c.key === key)!;

describe('mapa del dinero en cuatro preguntas: de qué campo sale cada cifra', () => {
  it('las cuatro tarjetas, en su orden y con su pregunta', () => {
    const q = moneyMapQuestions(map(), SECTIONS);
    expect(q.cards.map((c) => [c.key, c.question])).toEqual([
      ['ganado', '¿Cuánto he ganado?'],
      ['caja', '¿Cuánto tiene que haber en la caja?'],
      ['banco', '¿Cuánto llega al banco?'],
      ['debo', '¿Cuánto debo a las compañeras?'],
    ]);
  });

  it('«He ganado» es split.venueCents (lo del local tras personal y comisiones)', () => {
    expect(card(map(), 'ganado').cents).toBe(76_300);
    // Con la comisión del banco sin saber, lo dice.
    const unknownBank = map({ split: { ...map().split, commissions: { platformCents: 0, bankCents: null, totalCents: 0 } } });
    expect(card(unknownBank, 'ganado').caption).toContain('Sin la comisión del banco');
    expect(card(map(), 'ganado').caption).not.toContain('Sin la comisión del banco');
  });

  it('«La caja» es where.cashBoxCents y su texto desglosa fondo, entradas y salidas (no dice que el fondo va aparte)', () => {
    const c = card(map(), 'caja');
    expect(c.cents).toBe(50_000);
    expect(sp(c.caption)).toBe('Fondo de caja 100 € + efectivo cobrado 450 € − salidas 50 €. No sustituye al arqueo.');
    const noFloat = card(map({ where: { ...map().where, cashBox: { openingFloatCents: null, inCents: 450, outCents: 0 } } }), 'caja');
    expect(sp(noFloat.caption)).toContain('Sin fondo de caja apuntado');
  });

  it('«Cerrar la caja» solo con la noche en directo; en un Z o unas fechas, no', () => {
    expect(card(map(), 'caja').action).toBe('close-cash');
    expect(card(map({ frozen: true }), 'caja').action).toBeNull();
    expect(card(map({ scope: { kind: 'period' } }), 'caja').action).toBeNull();
  });

  it('«El banco» es where.bbvaCents; las devoluciones a tarjeta salen en el texto', () => {
    const c = card(map(), 'banco');
    expect(c.cents).toBe(68_200);
    expect(sp(c.caption)).toContain('menos 12 € devueltos');
    expect(sp(c.caption)).toContain('El día de abono lo confirma el banco');
    const clean = card(map({ outflow: { ...map().outflow, refunds: { cardCents: 0, cardCount: 0, cashCents: 0, cashCount: 0 } } }), 'banco');
    expect(clean.caption).not.toContain('menos');
  });

  it('«Debo a las compañeras» es where.owed.chicasCents (de esta noche y de antes)', () => {
    const c = card(map(), 'debo');
    expect(c.cents).toBe(10_700);
    expect(c.caption).toContain('de esta noche y de antes');
    expect(c.action).toBe('by-person');
  });

  it('sin deuda total (un periodo pasado) usa lo pendiente del periodo y lo dice', () => {
    const period = map({ scope: { kind: 'period' }, where: { ...map().where, owed: null } });
    const c = card(period, 'debo');
    expect(c.cents).toBe(9_000);
    expect(c.caption).toContain('la deuda total al corte no se conoce');
  });

  it('los camareros no se suman a las compañeras: salen aparte', () => {
    const m = map({ where: { ...map().where, owed: { chicasCents: 10_700, camarerosCents: 3_000 } } });
    const c = card(m, 'debo');
    expect(c.cents).toBe(10_700);
    expect(sp(c.caption)).toContain('Aparte, a camareros: 30 €');
  });

  it('el saldo sin gastar es where.liveSaldoCents; null se dice como no se sabe', () => {
    expect(sp(moneyMapQuestions(map(), SECTIONS).savedBalance.text)).toContain('217 € son saldo de clientes sin gastar');
    const unknown = moneyMapQuestions(map({ where: { ...map().where, liveSaldoCents: null } }), SECTIONS).savedBalance;
    expect(unknown.cents).toBeNull();
    expect(unknown.text).toContain('No se sabe');
  });

  it('«Lo vendido» es salesCents y sus secciones con importe', () => {
    const q = moneyMapQuestions(map({ sections: [...map().sections, { code: 'VENUE_ROOM', amountCents: 0, count: 0 }] }), SECTIONS);
    expect(q.sold.cents).toBe(97_700);
    expect(q.sold.label).toBe('Ventas de la noche');
    expect(q.sold.parts.map((p) => [p.label, p.cents])).toEqual([
      ['Copas', 52_000],
      ['Comida', 15_700],
      ['Entradas', 30_000],
    ]);
  });
});
