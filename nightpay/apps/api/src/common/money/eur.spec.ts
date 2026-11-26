import { describe, expect, it } from 'vitest';
import { eur, eurPlain } from './eur';

/** El espacio de no separación (U+00A0) que pone el formateador común antes de «€». */
const NBSP = '\u00a0';

describe('eur: los importes de los mensajes del servidor', () => {
  it('dos decimales, coma decimal y «€» detrás con el espacio de no separación', () => {
    expect(eur(0)).toBe(`0,00${NBSP}€`);
    expect(eur(500)).toBe(`5,00${NBSP}€`);
    expect(eur(1)).toBe(`0,01${NBSP}€`);
    expect(eur(99_999)).toBe(`999,99${NBSP}€`);
  });

  it('el punto de los miles siempre, también con cuatro cifras', () => {
    expect(eur(100_000)).toBe(`1.000,00${NBSP}€`);
    expect(eur(123_450)).toBe(`1.234,50${NBSP}€`);
    expect(eur(100_000_000)).toBe(`1.000.000,00${NBSP}€`);
  });

  it('un negativo lleva el signo menos de verdad, como en las apps', () => {
    expect(eur(-375)).toBe(`−3,75${NBSP}€`);
    expect(eur(-123_450)).toBe(`−1.234,50${NBSP}€`);
  });

  it('compact quita solo los «,00»', () => {
    expect(eur(0, { compact: true })).toBe(`0${NBSP}€`);
    expect(eur(500, { compact: true })).toBe(`5${NBSP}€`);
    expect(eur(14_050, { compact: true })).toBe(`140,50${NBSP}€`);
    expect(eur(140_000, { compact: true })).toBe(`1.400${NBSP}€`);
    expect(eur(123_450, { compact: true })).toBe(`1.234,50${NBSP}€`);
  });
});

describe('eurPlain: lo mismo para texto plano (Telegram, el asunto de un correo)', () => {
  it('espacio normal antes de «€» y ningún espacio de no separación', () => {
    expect(eurPlain(0)).toBe('0,00 €');
    expect(eurPlain(500)).toBe('5,00 €');
    expect(eurPlain(123_450)).toBe('1.234,50 €');
    expect(eurPlain(100_000_000)).toBe('1.000.000,00 €');
    expect(eurPlain(123_450)).not.toContain(NBSP);
  });

  it('un negativo, con el guion de siempre', () => {
    expect(eurPlain(-375)).toBe('-3,75 €');
    expect(eurPlain(-123_450)).toBe('-1.234,50 €');
  });

  it('compact quita solo los «,00»', () => {
    expect(eurPlain(14_000, { compact: true })).toBe('140 €');
    expect(eurPlain(14_050, { compact: true })).toBe('140,50 €');
    expect(eurPlain(140_000, { compact: true })).toBe('1.400 €');
  });
});
