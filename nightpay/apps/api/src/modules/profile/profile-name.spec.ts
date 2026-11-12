import { describe, expect, it } from 'vitest';
import { profileInitials, UpdateProfileSchema } from '@nightpay/contracts';

const parse = (displayName: unknown) => UpdateProfileSchema.safeParse({ displayName });

describe('nombre visible del perfil', () => {
  it('acepta un nombre normal, con tilde, ñ y espacios en medio', () => {
    expect(parse('Marina').success).toBe(true);
    expect(parse('José Ángel Núñez').success).toBe(true);
    expect(parse('Ana María').success).toBe(true);
  });

  it('acepta justo 2 y justo 40 caracteres', () => {
    expect(parse('Al').success).toBe(true);
    expect(parse('a'.repeat(40)).success).toBe(true);
  });

  it('rechaza el vacío y 1 carácter', () => {
    expect(parse('').success).toBe(false);
    expect(parse('A').success).toBe(false);
  });

  it('rechaza 41 caracteres', () => {
    expect(parse('a'.repeat(41)).success).toBe(false);
  });

  it('rechaza espacios a los lados (no los recorta en silencio)', () => {
    expect(parse(' Marina').success).toBe(false);
    expect(parse('Marina ').success).toBe(false);
    expect(parse('   ').success).toBe(false);
  });

  it('rechaza caracteres de control: salto de línea, tabulador, NUL, DEL y C1', () => {
    for (const bad of ['Mar\nina', 'Mar\tina', 'Mar\u0000ina', 'Mar\u007fina', 'Mar\u0085ina', 'Mar ina']) {
      expect(parse(bad).success).toBe(false);
    }
  });

  it('rechaza lo que no es texto', () => {
    expect(parse(undefined).success).toBe(false);
    expect(parse(12).success).toBe(false);
    expect(parse(null).success).toBe(false);
  });
});

describe('iniciales para quien no tiene foto', () => {
  it('una o dos letras en mayúsculas y «?» sin nombre', () => {
    expect(profileInitials('Marina')).toBe('M');
    expect(profileInitials('Ana María López')).toBe('AL');
    expect(profileInitials('  ')).toBe('?');
    expect(profileInitials(null)).toBe('?');
    expect(profileInitials('élodie')).toBe('É');
  });
});
