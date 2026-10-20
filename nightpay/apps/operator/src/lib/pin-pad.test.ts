import { describe, it, expect } from 'vitest';
import { FIXED_DIGITS, keypadDigits, shuffledDigits } from './pin-pad';

describe('teclado del PIN', () => {
  it('siempre las 10 cifras, una vez cada una', () => {
    for (let i = 0; i < 50; i++) {
      expect([...shuffledDigits()].sort()).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
    }
  });

  it('en otro orden cada vez (no el teclado de siempre)', () => {
    const orders = new Set(Array.from({ length: 20 }, () => shuffledDigits().join('')));
    expect(orders.size).toBeGreaterThan(15);
  });

  it('el orden lo decide el azar que se le da (para poder probarlo)', () => {
    expect(shuffledDigits(() => 0)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']);
  });
});

describe('teclado del PIN según el local (Ajustes → Noche)', () => {
  it('fijo (de fábrica): 1-9 y el 0 abajo, siempre igual', () => {
    expect(keypadDigits('fixed')).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']);
    expect(keypadDigits('fixed')).toEqual([...FIXED_DIGITS]);
    // Una copia: tocarla no cambia el teclado de siempre.
    keypadDigits('fixed').reverse();
    expect(FIXED_DIGITS[0]).toBe('1');
  });

  it('desordenado: las 10 cifras en otro orden cada vez', () => {
    expect([...keypadDigits('shuffled')].sort()).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
    expect(keypadDigits('shuffled', () => 0)).toEqual(shuffledDigits(() => 0));
  });
});
