import { describe, expect, it } from 'vitest';
import type { CobroRow } from '@nightpay/contracts';
import { clickOpensRow, dockKeyAction, dockRow, neighbour } from './cobro-dock';

// El detalle al lado de la lista (idea 16): qué fila enseña, a cuál se va con
// las flechas y cuándo una tecla no es para él. Puro, sin pantalla.

const row = (id: string, kind: CobroRow['kind'] = 'PAYMENT'): CobroRow => ({ kind, id }) as CobroRow;
const rows = [row('a'), row('b'), row('b', 'SALDO'), row('c')];
/** Un elemento de mentira: `closest` contesta según dónde esté. */
const inside = (...selectors: string[]) => ({ closest: (q: string) => (selectors.some((s) => q.split(',').map((x) => x.trim()).includes(s)) ? {} : null) });

describe('la fila del detalle', () => {
  it('sale de la lista en cada pintada (la última respuesta del API); si ya no está, la última vista', () => {
    const fresh = { ...row('b'), status: 'REFUNDED' } as CobroRow;
    const last = { ...row('b'), status: 'AUTHORIZED' } as CobroRow;
    expect(dockRow([row('a'), fresh], { kind: 'PAYMENT', id: 'b' }, last)).toBe(fresh);
    expect(dockRow([row('a')], { kind: 'PAYMENT', id: 'b' }, last)).toBe(last);
    expect(dockRow(null, { kind: 'PAYMENT', id: 'b' }, last)).toBe(last);
    expect(dockRow(rows, null, last)).toBeNull();
    // Mismo id en un cobro con tarjeta y en uno del saldo: son dos cobros.
    expect(dockRow(rows, { kind: 'SALDO', id: 'b' }, null)).toBe(rows[2]);
  });
});

describe('↑ y ↓: el cobro anterior o el siguiente de los cargados', () => {
  it('el vecino; en los bordes, nada', () => {
    expect(neighbour(rows, { kind: 'PAYMENT', id: 'b' }, 1)).toBe(rows[2]);
    expect(neighbour(rows, { kind: 'PAYMENT', id: 'b' }, -1)).toBe(rows[0]);
    expect(neighbour(rows, { kind: 'PAYMENT', id: 'a' }, -1)).toBeNull();
    expect(neighbour(rows, { kind: 'PAYMENT', id: 'c' }, 1)).toBeNull();
  });

  it('si el cobro abierto ya no está en la lista, o no hay ninguno abierto, nada', () => {
    expect(neighbour(rows, { kind: 'PAYMENT', id: 'z' }, 1)).toBeNull();
    expect(neighbour(rows, null, 1)).toBeNull();
    expect(neighbour(null, { kind: 'PAYMENT', id: 'a' }, 1)).toBeNull();
  });
});

describe('las teclas del detalle', () => {
  it('flechas y Esc', () => {
    expect(dockKeyAction('ArrowUp', inside())).toBe('prev');
    expect(dockKeyAction('ArrowDown', inside())).toBe('next');
    expect(dockKeyAction('Escape', inside())).toBe('close');
    expect(dockKeyAction('Enter', inside())).toBeNull();
    expect(dockKeyAction('a', inside())).toBeNull();
  });

  it('se ignoran desde un campo o desde una ventana: Esc en devolver o en «Verificar» cierra solo esa', () => {
    for (const where of ['input', 'select', 'textarea', '[role="dialog"]', '[role="alertdialog"]']) {
      for (const key of ['ArrowUp', 'ArrowDown', 'Escape']) expect(dockKeyAction(key, inside(where)), `${key} en ${where}`).toBeNull();
    }
    expect(dockKeyAction('Escape', null)).toBeNull();
  });
});

describe('tocar la fila abre el detalle', () => {
  it('un botón o un enlace de dentro (la ficha de la compañera, el saldo) no lo abre', () => {
    expect(clickOpensRow(inside())).toBe(true);
    expect(clickOpensRow(inside('button'))).toBe(false);
    expect(clickOpensRow(inside('a'))).toBe(false);
    expect(clickOpensRow(null)).toBe(false);
  });
});
