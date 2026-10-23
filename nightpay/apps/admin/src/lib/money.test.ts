import { describe, expect, it } from 'vitest';
import { centsToInput, formatDecimal, formatEur, formatMoney } from './money';

// Intl separa el símbolo con un espacio duro (U+00A0): se normaliza para comparar.
const NBSP = String.fromCharCode(160);
const plain = (s: string) => s.split(NBSP).join(' ');

describe('formatEur', () => {
  it('pone coma decimal y el euro detrás', () => {
    expect(plain(formatEur(1250))).toBe('12,50 €');
    expect(plain(formatEur(0))).toBe('0,00 €');
  });

  it('separa los miles con punto siempre, también con 4 cifras (como el mapa del dinero)', () => {
    expect(plain(formatEur(1_234_567))).toBe('12.345,67 €');
    expect(plain(formatEur(132_900))).toBe('1.329,00 €');
  });

  it('nunca se pierde un céntimo: 12,50 € es 12,50 € y 0,01 € es 0,01 €', () => {
    expect(plain(formatEur(1250))).toBe('12,50 €');
    expect(plain(formatEur(1))).toBe('0,01 €');
  });

  it('los negativos llevan el signo menos de verdad (U+2212), que se alinea con las cifras', () => {
    expect(plain(formatEur(-300))).toBe('\u22123,00 €');
  });
});

describe('formatMoney', () => {
  it('EUR igual que formatEur', () => {
    expect(formatMoney(999, 'EUR')).toBe(formatEur(999));
  });

  it('una moneda desconocida no rompe: importe y código', () => {
    expect(plain(formatMoney(150, 'XX1'))).toBe('1,50 XX1');
  });
});

describe('formatDecimal', () => {
  it('decimales fijos con coma', () => {
    expect(formatDecimal(1.07, 4)).toBe('1,0700');
    expect(formatDecimal(1234.5, 2)).toBe('1234,50');
  });
});

describe('centsToInput', () => {
  it('importe editable con coma, sin símbolo', () => {
    expect(centsToInput(1250)).toBe('12,50');
    expect(centsToInput(5)).toBe('0,05');
  });
});
