import { describe, expect, it } from 'vitest';
import {
  addedItemLabel,
  addedItemSpoken,
  addedTipLabel,
  addedTipSpoken,
  cobrarLabel,
  itemTileKey,
  tileLabel,
  tipTileKey,
  UNDO_MS,
  undoFocusTarget,
  undoTap,
} from './carta-view';
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

  it('mientras se crea el cobro, «Cobrando» (con tres puntos en pantalla)', () => {
    expect(plain(cobrarLabel({ busy: true, empty: false, totalCents: 3300 }))).toBe('Cobrando');
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
    const undone = undoTap({ id: 1, label: addedItemLabel('Nachos'), spoken: '', tile: itemTileKey('n'), before: two }, three);
    expect(undone).toBe(two);
    expect(qtyOf(undone, 'n')).toBe(0);
    expect(qtyOf(undone, 'g')).toBe(2);
    expect(qtyOf(three, 'n')).toBe(1);
  });

  it('también una propina; sin nada que deshacer, la cuenta se queda igual', () => {
    const base = addItem(EMPTY_CUENTA, gin);
    const tipped = addAmount(base, PROPINAS, 200);
    expect(undoTap({ id: 2, label: addedTipLabel(200), spoken: '', tile: tipTileKey(200), before: base }, tipped)).toBe(base);
    expect(undoTap(null, tipped)).toBe(tipped);
  });

  it('el lector de pantalla oye cada toque, también el mismo dos veces (dice cuántas lleva la cuenta)', () => {
    const first = addedItemSpoken('Nachos', 1);
    const second = addedItemSpoken('Nachos', 2);
    expect(first).toBe('+1 Nachos, 1 en la cuenta');
    expect(second).toBe('+1 Nachos, 2 en la cuenta');
    expect(second).not.toBe(first);
    expect(plain(addedTipSpoken(200, 200))).toBe('+2 € de propina, 2 € de propina en la cuenta');
    expect(plain(addedTipSpoken(200, 400))).toBe('+2 € de propina, 4 € de propina en la cuenta');
  });

  it('si «Deshacer» se va con el foco, el foco vuelve a la loseta que se tocó (si no está, al resumen)', () => {
    const tile = { name: 'loseta' };
    const sum = { name: 'resumen' };
    const asked: string[] = [];
    const root = (found: Record<string, object>) => ({
      querySelector: (selector: string) => {
        asked.push(selector);
        return found[selector] ?? null;
      },
    });
    expect(undoFocusTarget(root({ '[data-tile="n"]': tile, '[data-sum]': sum }), itemTileKey('n'))).toBe(tile);
    expect(undoFocusTarget(root({ '[data-sum]': sum }), tipTileKey(200))).toBe(sum);
    expect(asked).toContain('[data-tile="tip-200"]');
    expect(undoFocusTarget(root({}), 'n')).toBeNull();
  });
});
