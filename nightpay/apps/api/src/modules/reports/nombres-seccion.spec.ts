import { describe, it, expect } from 'vitest';
import { cobrosCsv, resumenCsv, summarize } from './export-csv';
import { cobroType, venueSectionLabeler, type CobroRow, type ConsumoRow, type RecargaEfectivoRow } from './export-rows';
import { parseReportPeriod } from './report-period';

// Noches (el Z, también el congelado) y los CSV de la gestoría dicen las
// secciones con el nombre que les puso el local en Ajustes → Secciones (los de
// fábrica de la app si no los cambió), como el resto del panel. Los importes no
// cambian: se suman por código de sección; solo cambia el nombre.

/** Las secciones de la demo: «Servicios» renombrada, «Comida» → «Cocina» y «Habitaciones» apagada. */
const DEMO = {
  CHICA_SERVICE: { label: 'Reservados VIP' },
  VENUE_FOOD: { label: 'Cocina' },
  VENUE_ROOM: { enabled: false },
};
const labelOf = venueSectionLabeler(DEMO);

const cobro = (o: Partial<CobroRow>): CobroRow => ({
  id: '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b',
  paidAt: new Date('2026-10-22T21:41:00Z'),
  status: 'AUTHORIZED',
  amountCents: 10_000,
  tipCents: 0,
  revenueCategory: 'VENUE_BAR',
  lines: null,
  captureMethod: 'QR',
  serviceName: null,
  payMethod: 'card',
  payMethodCode: null,
  cardBrand: null,
  cardType: null,
  cardCountry: null,
  authCode: null,
  providerTxId: null,
  walletId: null,
  creatorName: 'Carlos',
  creatorEmail: 'carlos@aurora.example',
  earningOperatorName: null,
  earningOperatorEmail: null,
  refundedCents: 0,
  commissionCents: null,
  earningTipCents: null,
  reversedCents: null,
  reversedAfterPayoutCents: 0,
  ...o,
});

const consumo = (o: Partial<ConsumoRow>): ConsumoRow => ({
  id: 'c-1',
  at: new Date('2026-10-22T22:00:00Z'),
  amountCents: 900,
  tipCents: 0,
  category: 'VENUE_FOOD',
  lines: null,
  operatorName: null,
  operatorEmail: null,
  commissionCents: null,
  earningTipCents: null,
  ...o,
});

const recargaEfectivo: RecargaEfectivoRow = {
  id: 'ct-1',
  at: new Date('2026-10-22T21:00:00Z'),
  amountCents: 5_000,
  takenByName: 'Sergio',
  takenByEmail: 'sergio@aurora.example',
  terminalLabel: null,
};

// La noche, a mano:
//  - gin tonic 12 € + nachos 9 € con 2 € de propina (principal: Copas) → Copas 14 €, Cocina 9 €
//  - reservado VIP 150 €                                                → Reservados VIP 150 €
//  - entrada 15 € (cobro de antes, sin líneas)                          → Entradas 15 €
//  - recarga con tarjeta 50 € y recarga en efectivo 50 €               → aparte, no son secciones
// Cobrado: 21 + 150 + 15 + 50 (importes) + 2 (propina) + 50 (efectivo) = 288 €.
const COBROS = [
  cobro({
    amountCents: 2_100,
    tipCents: 200,
    lines: [
      { category: 'VENUE_BAR', amountCents: 1_200 },
      { category: 'VENUE_FOOD', amountCents: 900 },
    ],
  }),
  cobro({ amountCents: 15_000, revenueCategory: 'CHICA_SERVICE', lines: [{ category: 'CHICA_SERVICE', amountCents: 15_000 }] }),
  cobro({ amountCents: 1_500, revenueCategory: 'VENUE_ENTRY' }),
  cobro({ amountCents: 5_000, revenueCategory: 'EXTRA', walletId: 'w-1' }),
];

describe('los nombres de sección del local', () => {
  it('los de Ajustes → Secciones; lo que no cambió, los de fábrica de la app; los de antes sin sección, «Otros»', () => {
    expect(['CHICA_SERVICE', 'VENUE_BAR', 'VENUE_ROOM', 'VENUE_FOOD', 'VENUE_ENTRY', 'EXTRA'].map(labelOf)).toEqual([
      'Reservados VIP',
      'Copas',
      'Habitaciones',
      'Cocina',
      'Entradas',
      'Otros',
    ]);
    const factory = venueSectionLabeler(null);
    expect(['CHICA_SERVICE', 'VENUE_BAR', 'VENUE_ROOM', 'VENUE_FOOD', 'VENUE_ENTRY'].map(factory)).toEqual([
      'Servicios',
      'Copas',
      'Habitaciones',
      'Comida',
      'Entradas',
    ]);
  });

  it('el Z «por tipo»: los nombres del local, en el orden de las secciones, y las recargas detrás', () => {
    const s = summarize(COBROS, [], [], [], [], [recargaEfectivo], { labelOf });
    expect(s.byType).toEqual([
      { label: 'Reservados VIP', count: 1, chargedCents: 15_000 },
      { label: 'Copas', count: 1, chargedCents: 1_400 },
      { label: 'Cocina', count: 1, chargedCents: 900 },
      { label: 'Entradas', count: 1, chargedCents: 1_500 },
      { label: 'Recarga con tarjeta', count: 1, chargedCents: 5_000 },
      { label: 'Recarga en efectivo', count: 1, chargedCents: 5_000 },
    ]);
    expect(s.chargedCents).toBe(28_800);
    expect(s.byType.reduce((a, t) => a + t.chargedCents, 0)).toBe(s.chargedCents);
  });

  it('solo cambia el nombre: mismas cuentas e importes que con los nombres de antes', () => {
    const named = summarize(COBROS, [], [], [consumo({})], [], [recargaEfectivo], { labelOf });
    const plain = summarize(COBROS, [], [], [consumo({})], [], [recargaEfectivo]);
    const figures = (lines: ReadonlyArray<{ count: number; chargedCents: number }>) => lines.map((t) => [t.count, t.chargedCents]);
    expect(figures(named.byType)).toEqual(figures(plain.byType));
    expect(figures(named.saldoByType)).toEqual(figures(plain.saldoByType));
    expect({ ...named, byType: [], saldoByType: [] }).toEqual({ ...plain, byType: [], saldoByType: [] });
  });

  it('los consumos del saldo, también con el nombre del local', () => {
    const s = summarize([], [], [], [consumo({}), consumo({ id: 'c-2', category: 'CHICA_SERVICE', amountCents: 10_000 })], [], [], { labelOf });
    expect(s.saldoByType).toEqual([
      { label: 'Reservados VIP', count: 1, chargedCents: 10_000 },
      { label: 'Cocina', count: 1, chargedCents: 900 },
    ]);
  });

  it('una sección que el local llame como una recarga no se mezcla con las recargas', () => {
    const odd = venueSectionLabeler({ VENUE_BAR: { label: 'Recarga con tarjeta' } });
    const s = summarize(COBROS, [], [], [], [], [], { labelOf: odd });
    expect(s.byType.filter((t) => t.label === 'Recarga con tarjeta')).toEqual([
      { label: 'Recarga con tarjeta', count: 1, chargedCents: 1_400 },
      { label: 'Recarga con tarjeta', count: 1, chargedCents: 5_000 },
    ]);
  });

  it('el tipo de cada cobro: sus secciones con el nombre del local', () => {
    expect(cobroType(COBROS[0]!, labelOf)).toBe('Copas + Cocina');
    expect(cobroType(COBROS[1]!, labelOf)).toBe('Reservados VIP');
    expect(cobroType(COBROS[3]!, labelOf)).toBe('Recarga con tarjeta');
  });

  it('los CSV de la gestoría (libro de cobros y resumen), con los nombres del local', () => {
    const libro = cobrosCsv(COBROS, 'Sala Aurora', labelOf);
    expect(libro).toContain(';Copas + Cocina;Copas + Cocina;Carlos;');
    expect(libro).toContain(';Copas 12,00 · Cocina 9,00');
    expect(libro).toContain(';Reservados VIP;Reservados VIP;');
    const period = parseReportPeriod('2026-10-22', '2026-10-22');
    if (!period.ok) throw new Error(period.error);
    const resumen = resumenCsv({
      venueName: 'Sala Aurora',
      period: period.period,
      generatedAt: new Date('2026-10-23T08:00:00Z'),
      summary: summarize(COBROS, [], [], [consumo({})], [], [recargaEfectivo], { labelOf }),
    });
    expect(resumen).toContain('Reservados VIP;150,00;1');
    expect(resumen).toContain('Copas;14,00;1');
    expect(resumen).toContain('Cocina;9,00;1');
    expect(resumen).toContain('Recarga con tarjeta;50,00;1');
    for (const csv of [libro, resumen]) {
      for (const old of ['Servicio de chica', 'Barra', 'Comida', 'Entrada;']) expect(csv).not.toContain(old);
    }
  });
});

describe('un nombre de sección que empieza como una fórmula de Excel', () => {
  // El nombre lo escribe el dueño en Ajustes → Secciones: en el CSV va siempre como
  // texto (con el apóstrofo delante), nunca como una fórmula que Excel ejecute.
  const formula = venueSectionLabeler({ VENUE_BAR: { label: '=1+1' } });

  it('el libro de cobros (tipo, concepto y por sección) y el resumen', () => {
    const libro = cobrosCsv([cobro({})], 'Sala Aurora', formula);
    expect(libro).toContain(";'=1+1;'=1+1;Carlos;");
    expect(libro).toContain(";'=1+1 100,00");
    const period = parseReportPeriod('2026-10-22', '2026-10-22');
    if (!period.ok) throw new Error(period.error);
    const resumen = resumenCsv({
      venueName: 'Sala Aurora',
      period: period.period,
      generatedAt: new Date('2026-10-23T08:00:00Z'),
      summary: summarize([cobro({})], [], [], [consumo({ category: 'VENUE_BAR' })], [], [], { labelOf: formula }),
    });
    expect(resumen).toContain("'=1+1;100,00;1");
    for (const csv of [libro, resumen]) expect(csv).not.toMatch(/(^|;)=1\+1/m);
  });
});
