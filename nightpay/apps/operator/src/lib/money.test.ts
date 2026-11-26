import { describe, expect, it } from 'vitest';
import { formatBps, formatEur, formatSignedEur } from './money';

// Intl separa la cifra del "€" con un espacio que no se parte (U+00A0).
const nb = (s: string) => s.replace(/ /g, ' ');

describe('importes en euros', () => {
  it('coma decimal y € detrás, como en España', () => {
    expect(formatEur(6050)).toBe(nb('60,50 €'));
    expect(formatEur(6000)).toBe(nb('60,00 €'));
    expect(formatEur(5)).toBe(nb('0,05 €'));
    expect(formatEur(1_234_567)).toBe(nb('12.345,67 €'));
  });

  it('compacto: sin ",00" cuando no hay céntimos (carta, saldo)', () => {
    expect(formatEur(6000, { compact: true })).toBe(nb('60 €'));
    expect(formatEur(6050, { compact: true })).toBe(nb('60,50 €'));
    expect(formatEur(-6000, { compact: true })).toBe(nb('\u221260 €'));
    // El punto de los miles siempre (como el panel y el cliente).
    expect(formatEur(110_900, { compact: true })).toBe(nb('1.109 €'));
  });

  it('con signo: nunca "+-1,20"', () => {
    expect(formatSignedEur(120)).toBe(nb('+1,20 €'));
    expect(formatSignedEur(-120)).toBe(nb('−1,20 €'));
    expect(formatSignedEur(0)).toBe(nb('0,00 €'));
  });

  // Antes había un formatEurAmount («123,45», con «EUR» aparte): el cobro abierto y los POS
  // pendientes escriben ya el importe entero, con su «€» (Piezas I).
  it('el importe entero con su «€», nunca la cifra suelta con «EUR» aparte', () => {
    expect(formatEur(12345)).toBe(nb('123,45 €'));
    expect(formatEur(-50)).toBe(nb('\u22120,50 €'));
    expect(formatEur(123_456)).toBe(nb('1.234,56 €'));
  });

  it('comisión en puntos básicos, sin redondear', () => {
    expect(formatBps(3000)).toBe(nb('30 %'));
    expect(formatBps(3750)).toBe(nb('37,5 %'));
  });
});
