import { describe, it, expect } from 'vitest';
import { parseEuroCents } from '@nightpay/contracts';

describe('importe tecleado', () => {
  it('formatos españoles y con punto', () => {
    expect(parseEuroCents('50')).toBe(5000);
    expect(parseEuroCents('50,5')).toBe(5050);
    expect(parseEuroCents('50.50')).toBe(5050);
    expect(parseEuroCents(' 75 € ')).toBe(7500);
    expect(parseEuroCents('1.234,56')).toBe(123456);
    expect(parseEuroCents('1.234')).toBe(123400);
    expect(parseEuroCents('1.005')).toBe(100500);
    expect(parseEuroCents('0,01')).toBe(1);
  });

  it('sin decimales de coma flotante', () => {
    expect(parseEuroCents('1,15')).toBe(115);
    expect(parseEuroCents('4,35')).toBe(435);
    expect(parseEuroCents('1,005')).toBeNull();
  });

  it('basura, cero y por encima del tope → null', () => {
    for (const bad of ['', '0', '0,00', '12abc', '1,5,3', '1,234.5', '-5', 'abc', '.5', '5.', '1e3']) {
      expect(parseEuroCents(bad)).toBeNull();
    }
    expect(parseEuroCents('100001')).toBeNull();
    expect(parseEuroCents('200', 10_000)).toBeNull();
  });
});
