import { describe, expect, it } from 'vitest';
import { bpsToPercentInput, formatBps, parsePercentToBps, splitExample } from './commission';

describe('parsePercentToBps', () => {
  it('porcentajes limpios con coma o punto', () => {
    expect(parsePercentToBps('10')).toBe(1000);
    expect(parsePercentToBps('10,5')).toBe(1050);
    expect(parsePercentToBps('10.25')).toBe(1025);
    expect(parsePercentToBps(' 90 % ')).toBe(9000);
    expect(parsePercentToBps('0')).toBe(0);
    expect(parsePercentToBps('100')).toBe(10_000);
  });

  it('rechaza lo que parseFloat dejaba pasar', () => {
    expect(parsePercentToBps('10abc')).toBeNull();
    expect(parsePercentToBps('1,2,3')).toBeNull();
    expect(parsePercentToBps('')).toBeNull();
    expect(parsePercentToBps('-5')).toBeNull();
    expect(parsePercentToBps('10,555')).toBeNull();
  });

  it('más del 100 % no vale', () => {
    expect(parsePercentToBps('100,01')).toBeNull();
    expect(parsePercentToBps('150')).toBeNull();
  });
});

describe('formato', () => {
  it('campo y lectura', () => {
    expect(bpsToPercentInput(1050)).toBe('10,50');
    // El de toda la app (@nightpay/ui): con espacio duro antes del «%».
    expect(formatBps(1000)).toBe('10\u00a0%');
    expect(formatBps(1050)).toBe('10,5\u00a0%');
  });
});

describe('splitExample', () => {
  it('100 € con OxioPay al 10 % y chica al 90 %: el local se queda 0', () => {
    expect(splitExample(10_000, 1000, 9000)).toEqual({ platformCents: 1000, chicaCents: 9000, venueCents: 0 });
  });

  it('OxioPay al 15 %: el ejemplo ya no dice "10 €" ni "local 0 €"', () => {
    expect(splitExample(10_000, 1500, 9000)).toEqual({ platformCents: 1500, chicaCents: 9000, venueCents: -500 });
  });

  it('chica al 60 %: el resto es del local', () => {
    expect(splitExample(10_000, 1000, 6000).venueCents).toBe(3000);
  });
});
