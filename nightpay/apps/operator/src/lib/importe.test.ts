import { describe, expect, it } from 'vitest';
import { IMPORTE_KEYS, importeCents, importeShown, pressImporte, type ImporteKey } from './importe';

const type = (keys: string, max?: number): string =>
  [...keys].reduce((typed, k) => pressImporte(typed, (k === '<' ? 'back' : k) as ImporteKey, max), '');

describe('«Otro importe»: se teclea en euros', () => {
  it('35 → 35 €; 12,5 → 12,50 €; la coma sola → 0,', () => {
    expect(importeCents(type('35'))).toBe(3500);
    expect(importeCents(type('12,5'))).toBe(1250);
    expect(type(',')).toBe('0,');
    expect(importeCents(type(',5'))).toBe(50);
  });

  it('dos decimales como mucho, una coma, sin ceros delante; borrar', () => {
    expect(type('12,345')).toBe('12,34');
    expect(type('1,,2')).toBe('1,2');
    expect(type('007')).toBe('7');
    expect(type('35<')).toBe('3');
    expect(type('<')).toBe('');
  });

  it('no pasa del tope (10.000 € o el que se diga)', () => {
    expect(type('100001')).toBe('10000');
    expect(type('999', 5000)).toBe('9');
  });

  it('lo que se ve y el teclado de la maqueta', () => {
    expect(importeShown('')).toBe('0');
    expect(importeShown('35')).toBe('35');
    expect(IMPORTE_KEYS).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', ',', '0', 'back']);
  });
});
