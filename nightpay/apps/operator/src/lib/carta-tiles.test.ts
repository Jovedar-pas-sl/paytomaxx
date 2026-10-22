import { describe, expect, it } from 'vitest';
import { CARTA_TEMPLATE } from '@nightpay/contracts';
import { addItem, EMPTY_CUENTA, type CartaItem } from './cuenta';
import { cartaTiles, itemAllowed, tapOf } from './carta-tiles';

/** La carta de referencia tal como llega del API (por su orden). */
const carta: CartaItem[] = CARTA_TEMPLATE.map((p, n) => ({
  id: `p${n}`,
  name: p.name,
  priceCents: p.priceCents,
  category: p.category,
  durationMin: p.durationMin,
  isInvitation: p.isInvitation ?? false,
}));
const BARRA = ['VENUE_BAR', 'VENUE_FOOD', 'VENUE_ENTRY'];

describe('la carta del camarero: «Copa» y «Copa con invitación»', () => {
  it('la copa con invitación es una loseta más, justo después de «Copa»', () => {
    const tiles = cartaTiles(carta, BARRA);
    expect(tiles.slice(0, 3).map((t) => t.name)).toEqual(['Copa', 'Copa con invitación', 'Botella']);
    expect(tiles.filter((t) => t.isInvitation)).toHaveLength(1);
    // Solo las de su puesto (la barra no cobra Servicios), en el orden de las secciones.
    expect(tiles.map((t) => t.category)).toEqual([
      'VENUE_BAR', 'VENUE_BAR', 'VENUE_BAR', 'VENUE_BAR', 'VENUE_FOOD', 'VENUE_FOOD', 'VENUE_ENTRY', 'VENUE_ENTRY',
    ]);
  });

  it('dentro de cada sección, el orden de la carta (aunque el API las mande mezcladas)', () => {
    const mixed = [carta[4]!, carta[0]!, carta[6]!, carta[1]!];
    expect(cartaTiles(mixed, BARRA).map((t) => t.name)).toEqual(['Copa', 'Copa con invitación', 'Tabla ibérica', 'Entrada']);
  });

  it('una invitación de un puesto que no cobra Copas no sale (como cualquier producto)', () => {
    expect(cartaTiles(carta, ['CHICA_SERVICE']).some((t) => t.isInvitation)).toBe(false);
    expect(itemAllowed(carta[1]!, ['VENUE_BAR'])).toBe(true);
    expect(itemAllowed({ ...carta[0]!, components: [{ category: 'VENUE_BAR', amountCents: 500 }, { category: 'VENUE_ROOM', amountCents: 500 }] }, ['VENUE_BAR'])).toBe(false);
  });

  it('tocar «Copa» la suma a la cuenta; tocar «Copa con invitación», escanear el QR de la chica', () => {
    const copa = carta[0]!;
    const invita = carta[1]!;
    expect(tapOf(copa)).toBe('sumar');
    expect(tapOf(invita)).toBe('invitar');
    // La primera copa ya no pregunta nada: va directa a la cuenta.
    expect(addItem(EMPTY_CUENTA, copa)).toEqual([expect.objectContaining({ kind: 'carta', item: copa, qty: 1 })]);
  });
});
