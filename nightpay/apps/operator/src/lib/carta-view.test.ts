import { describe, expect, it } from 'vitest';
import { addedItemLabel, addedTipLabel, cobrarLabel, tileLabel, UNDO_MS, undoTap } from './carta-view';
import { addAmount, addItem, EMPTY_CUENTA, PROPINAS, qtyOf } from './cuenta';

/** Intl pone un espacio duro antes de «€»: aquí se compara con espacios normales. */
const plain = (s: string): string => s.replace(/\u00a0/g, ' ');

const gin = { id: 'g', name: 'Gin tonic', priceCents: 1200, category: 'VENUE_BAR' };
const nachos = { id: 'n', name: 'Nachos', priceCents: 900, category: 'VENUE_FOOD' };

describe('el botón de abajo (decisión D1)', () => {
  it('sin nada en la cuenta dice qué hacer, no «Cobrar»', () => {
    expect(plain(cobrarLabel({ busy: false, empty: true, totalCents: 0 }))).toBe('Toca lo que te pide el cliente');
  });

  it('con algo, «Cobrar 33 €» (sin «,00»); con céntimos, con ellos', () => {
    expect(plain(cobrarLabel({ busy: false, empty: false, totalCents: 3300 }))).toBe('Cobrar 33 €');
    expect(plain(cobrarLabel({ busy: false, empty: false, totalCents: 3350 }))).toBe('Cobrar 33,50 €');
  });

  it('mientras se crea el cobro, «Un momento…»', () => {
    expect(plain(cobrarLabel({ busy: true, empty: false, totalCents: 3300 }))).toBe('Un momento…');
  });
});

describe('el nombre de la loseta para el lector de pantalla', () => {
  it('dice cuántas lleva la cuenta', () => {
    expect(plain(tileLabel('Gin tonic', 1200, { qty: 2 }))).toBe('Gin tonic, 12,00 €, 2 en la cuenta');
    expect(plain(tileLabel('Gin tonic', 1200))).toBe('Gin tonic, 12,00 €');
  });

  it('la copa con invitación dice que se escanea el QR', () => {
    expect(plain(tileLabel('Invitar a una copa', 1200, { invite: true, qty: 3 }))).toBe('Invitar a una copa, 12,00 €. Escanea el QR de la chica');
  });
});

describe('«Deshacer» en el pie (decisión D3)', () => {
  it('dura 4 segundos', () => {
    expect(UNDO_MS).toBe(4000);
  });

  it('dice lo último que se tocó', () => {
    expect(addedItemLabel('Nachos')).toBe('+1 Nachos');
    expect(plain(addedTipLabel(200))).toBe('+2 € de propina');
    expect(plain(addedTipLabel(250))).toBe('+2,50 € de propina');
  });

  it('vuelve a la cuenta de antes del último toque (sin tocar la de ahora)', () => {
    const one = addItem(EMPTY_CUENTA, gin);
    const two = addItem(one, gin);
    const three = addItem(two, nachos);
    const undone = undoTap({ id: 1, label: addedItemLabel('Nachos'), before: two }, three);
    expect(undone).toBe(two);
    expect(qtyOf(undone, 'n')).toBe(0);
    expect(qtyOf(undone, 'g')).toBe(2);
    expect(qtyOf(three, 'n')).toBe(1);
  });

  it('también una propina; sin nada que deshacer, la cuenta se queda igual', () => {
    const base = addItem(EMPTY_CUENTA, gin);
    const tipped = addAmount(base, PROPINAS, 200);
    expect(undoTap({ id: 2, label: addedTipLabel(200), before: base }, tipped)).toBe(base);
    expect(undoTap(null, tipped)).toBe(tipped);
  });
});
