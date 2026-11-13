import { describe, expect, it } from 'vitest';
import type { VenueSection } from '@nightpay/contracts';
import { EMPTY_CUENTA, addAmount, addItem, chargeLinesOf, cuentaTotals, type CartaItem } from './cuenta';
import {
  ALL,
  barraCobrarLabel,
  barraFilters,
  barraTileAria,
  barraTiles,
  filterTiles,
  partyPaidRows,
  partySections,
  resolveFilter,
  stepLine,
  ticketCount,
  ticketLines,
  ticketSummary,
  ticketTitle,
  tileIconOf,
} from './party-barra';

// Intl separa la cifra del «€» con un espacio que no se parte (U+00A0).
const nb = (text: string) => text.replace(/ €/g, '\u00a0€');

const item = (id: string, name: string, priceCents: number, category: string, extra: Partial<CartaItem> = {}): CartaItem => ({
  id,
  name,
  priceCents,
  category,
  ...extra,
});

const CANA = item('cana', 'Caña', 200, 'VENUE_BAR');
const TINTO = item('tinto', 'Tinto de verano', 300, 'VENUE_BAR');
const BOCATA = item('bocata', 'Bocadillo', 450, 'VENUE_FOOD');
const INVITA = item('inv', 'Copa con invitación', 1000, 'VENUE_BAR', { isInvitation: true });
const LABEL: Record<string, string> = { VENUE_BAR: 'Bebidas', VENUE_FOOD: 'Comida' };
const labelOf = (s: string) => LABEL[s] ?? s;

describe('OxioParty · barra: las cuentas del ticket', () => {
  it('suma cada toque y cuenta los artículos (2 cañas + 1 tinto = 3 artículos, 7,00 €)', () => {
    const c = addItem(addItem(addItem(EMPTY_CUENTA, CANA), CANA), TINTO);
    expect(ticketCount(c)).toBe(3);
    expect(ticketTitle(ticketCount(c))).toBe('Ticket · 3 artículos');
    expect(ticketTitle(1)).toBe('Ticket · 1 artículo');
    expect(cuentaTotals(c).totalCents).toBe(700);
    expect(barraCobrarLabel(cuentaTotals(c).totalCents)).toBe(nb('Cobrar 7,00 €'));
    expect(ticketLines(c).map((l) => [l.name, l.qty, l.cents])).toEqual([
      ['Caña', 2, 400],
      ['Tinto de verano', 1, 300],
    ]);
  });

  it('− y + en una línea; a 0 sale del ticket; nunca cambia la cuenta de antes', () => {
    const c = addItem(addItem(EMPTY_CUENTA, CANA), CANA);
    const key = c[0]!.key;
    const more = stepLine(c, key, 1);
    expect(ticketLines(more)[0]!.qty).toBe(3);
    expect(ticketLines(c)[0]!.qty).toBe(2);
    const less = stepLine(stepLine(c, key, -1), key, -1);
    expect(less).toEqual([]);
    expect(stepLine(c, 'no-existe', 1)).toBe(c);
  });

  it('un «Otro importe» va al ticket como una línea sin «+»; «−» lo quita', () => {
    const c = addAmount(addItem(EMPTY_CUENTA, CANA), 'VENUE_BAR', 550);
    const lines = ticketLines(c);
    expect(lines[1]).toMatchObject({ name: 'Otro importe', qty: 1, cents: 550, canAdd: false });
    expect(ticketCount(c)).toBe(2);
    expect(stepLine(c, lines[1]!.key, 1)).toBe(c);
    expect(ticketLines(stepLine(c, lines[1]!.key, -1))).toHaveLength(1);
  });

  it('el cobro con varias líneas es el de siempre: una línea por cosa de la carta (POST /v1/payments)', () => {
    const c = addAmount(addItem(addItem(addItem(EMPTY_CUENTA, CANA), CANA), BOCATA), 'VENUE_BAR', 550);
    expect(chargeLinesOf(c)).toEqual([
      { serviceItemId: 'cana', qty: 2 },
      { serviceItemId: 'bocata', qty: 1 },
      { category: 'VENUE_BAR', amountCents: 550, label: 'Otro importe' },
    ]);
  });

  it('el resumen de lo que se cobra: «2 × caña · 1 × tinto de verano»', () => {
    const c = addItem(addItem(addItem(EMPTY_CUENTA, CANA), CANA), TINTO);
    expect(ticketSummary(c)).toBe('2 × caña · 1 × tinto de verano');
  });

  it('cada loseta se anuncia con su precio y lo que lleva', () => {
    expect(barraTileAria('Caña', 200, 0)).toBe(nb('Añadir Caña, 2,00 €'));
    expect(barraTileAria('Caña', 200, 2)).toBe(nb('Añadir Caña, 2,00 €. Lleva 2'));
  });
});

describe('OxioParty · barra: el filtro por sección', () => {
  const tiles = [CANA, TINTO, BOCATA];

  it('«Todo» más cada sección con losetas, en su orden y con el nombre del local', () => {
    expect(barraFilters(tiles, labelOf)).toEqual([
      { key: ALL, label: 'Todo' },
      { key: 'VENUE_BAR', label: 'Bebidas' },
      { key: 'VENUE_FOOD', label: 'Comida' },
    ]);
  });

  it('con una sola sección no hay filtro', () => {
    expect(barraFilters([CANA, TINTO], labelOf)).toEqual([]);
    expect(barraFilters([], labelOf)).toEqual([]);
  });

  it('filtra las losetas; «Todo» las deja todas', () => {
    expect(filterTiles(tiles, ALL)).toEqual(tiles);
    expect(filterTiles(tiles, 'VENUE_FOOD')).toEqual([BOCATA]);
    expect(filterTiles(tiles, 'VENUE_BAR')).toEqual([CANA, TINTO]);
  });

  it('un filtro que ya no existe (la carta cambió) vuelve a «Todo»', () => {
    const filters = barraFilters(tiles, labelOf);
    expect(resolveFilter('VENUE_FOOD', filters)).toBe('VENUE_FOOD');
    expect(resolveFilter('VENUE_ENTRY', filters)).toBe(ALL);
    expect(resolveFilter('VENUE_BAR', [])).toBe(ALL);
  });

  it('cada sección con su icono: bebida, comida, entrada u otra', () => {
    expect(tileIconOf('VENUE_BAR')).toBe('drink');
    expect(tileIconOf('VENUE_FOOD')).toBe('food');
    expect(tileIconOf('VENUE_ENTRY')).toBe('ticket');
    expect(tileIconOf('CHICA_SERVICE')).toBe('other');
  });
});

describe('OxioParty · barra: lo que no es de una fiesta', () => {
  it('sin copas con invitación (no hay chicas)', () => {
    expect(barraTiles([CANA, INVITA, BOCATA], ['VENUE_BAR', 'VENUE_FOOD'])).toEqual([CANA, BOCATA]);
  });

  it('sin habitaciones ni servicios: esas secciones, apagadas (sin tocar las demás ni la lista de antes)', () => {
    const sections: VenueSection[] = [
      { code: 'CHICA_SERVICE', label: 'Servicios', color: 'x', enabled: true },
      { code: 'VENUE_BAR', label: 'Bebidas', color: 'x', enabled: true },
      { code: 'VENUE_ROOM', label: 'Habitaciones', color: 'x', enabled: true },
      { code: 'VENUE_FOOD', label: 'Comida', color: 'x', enabled: false },
    ] as VenueSection[];
    const party = partySections(sections);
    expect(party.map((s) => [s.code, s.enabled])).toEqual([
      ['CHICA_SERVICE', false],
      ['VENUE_BAR', true],
      ['VENUE_ROOM', false],
      ['VENUE_FOOD', false],
    ]);
    expect(sections[0]!.enabled).toBe(true);
  });
});

describe('OxioParty · barra: el detalle del PAGADO', () => {
  // 01:47 en Madrid (noviembre, UTC+1).
  const AT = new Date('2026-11-14T00:47:00Z');

  it('con la pulsera: su número, lo que le queda y la hora', () => {
    expect(partyPaidRows({ method: 'saldo', pulsera: 'P-0412', newBalanceCents: 1300, at: AT })).toEqual([
      { label: 'Pulsera', value: 'P-0412' },
      { label: 'Le quedan', value: nb('13,00 €') },
      { label: 'Hora', value: '01:47' },
    ]);
  });

  it('lo que el API no da no sale (sin número de pulsera ni saldo, solo la hora)', () => {
    expect(partyPaidRows({ method: 'saldo', pulsera: null, newBalanceCents: null, at: AT })).toEqual([{ label: 'Hora', value: '01:47' }]);
  });

  it('con tarjeta: cómo pagó y el código del cobro', () => {
    expect(partyPaidRows({ method: 'card', pulsera: null, newBalanceCents: null, wallet: true, code: 'K7Q', at: AT })).toEqual([
      { label: 'Pagado con', value: 'Apple Pay o Google Pay' },
      { label: 'Código del cobro', value: 'K7Q' },
      { label: 'Hora', value: '01:47' },
    ]);
  });
});
