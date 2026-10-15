import { describe, expect, it } from 'vitest';
import { MAX_TYPED_AMOUNT_CENTS } from '@nightpay/contracts';
import {
  DEFAULT_KEYPAD_MAX_CENTS,
  KEYPAD_LAYOUT,
  keypadKeyFromKeyboard,
  keypadKeyLabel,
  pressKeypad,
  type KeypadKey,
} from '@nightpay/ui';

const type = (keys: KeypadKey[], start = 0, max?: number) => keys.reduce((c, k) => pressKeypad(c, k, max), start);

describe('teclado de importe (en céntimos, como un datáfono)', () => {
  it('las cifras entran por la derecha: 5-0-0-0 → 50,00 €', () => {
    expect(type(['5'])).toBe(5);
    expect(type(['5', '0'])).toBe(50);
    expect(type(['5', '0', '0', '0'])).toBe(5000);
    expect(type(['4', '8', '5', '0'])).toBe(4850);
  });

  it('«00» añade dos ceros: 5-00-00 → 50,00 €', () => {
    expect(type(['5', '00', '00'])).toBe(50000);
    expect(type(['5', '00'])).toBe(500);
  });

  it('ceros a la izquierda no cuentan', () => {
    expect(type(['0', '00', '0', '7'])).toBe(7);
  });

  it('borrar quita la última cifra; borrar todo vuelve a cero', () => {
    expect(type(['5', '0', '0', 'back'])).toBe(50);
    expect(type(['back'])).toBe(0);
    expect(type(['9', '9', 'clear'])).toBe(0);
  });

  it('una cifra que pasa del tope no entra', () => {
    expect(type(['1', '0', '0'], 0, 1000)).toBe(100);
    expect(type(['1', '0', '0', '0', '0'], 0, 1000)).toBe(1000);
    expect(pressKeypad(999, '00', 1000)).toBe(999);
  });

  it('el tope por defecto es el de los importes tecleados (100.000 €)', () => {
    expect(DEFAULT_KEYPAD_MAX_CENTS).toBe(MAX_TYPED_AMOUNT_CENTS);
    expect(pressKeypad(DEFAULT_KEYPAD_MAX_CENTS, '0')).toBe(DEFAULT_KEYPAD_MAX_CENTS);
  });

  it('un valor raro de partida cuenta como cero', () => {
    expect(pressKeypad(Number.NaN, '5')).toBe(5);
    expect(pressKeypad(-30, '5')).toBe(5);
  });

  it('3×4 y siempre en el mismo orden (el del PIN sí se baraja)', () => {
    expect(KEYPAD_LAYOUT).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', 'back']);
  });

  it('teclado físico: cifras, retroceso y suprimir; lo demás no', () => {
    expect(keypadKeyFromKeyboard('7')).toBe('7');
    expect(keypadKeyFromKeyboard('Backspace')).toBe('back');
    expect(keypadKeyFromKeyboard('Delete')).toBe('clear');
    expect(keypadKeyFromKeyboard(',')).toBeNull();
    expect(keypadKeyFromKeyboard('a')).toBeNull();
    expect(keypadKeyFromKeyboard('Enter')).toBeNull();
  });

  it('las teclas sin cifra tienen nombre para el lector de pantalla', () => {
    expect(keypadKeyLabel('back')).toBe('Borrar');
    expect(keypadKeyLabel('00')).toBe('Dos ceros');
    expect(keypadKeyLabel('4')).toBe('4');
  });
});
