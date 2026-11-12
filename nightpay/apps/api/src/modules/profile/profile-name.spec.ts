import { describe, expect, it } from 'vitest';
import { cleanDisplayName, hasInvisibleChars, profileInitials, UpdateProfileSchema } from '@nightpay/contracts';

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

  it('limpia el nombre: espacios a los lados fuera, repetidos a uno y NFC', () => {
    expect(UpdateProfileSchema.parse({ displayName: '  Marina   Díaz ' }).displayName).toBe('Marina Díaz');
    // «é» descompuesto (e + acento) pasa a una sola letra.
    const decomposed = 'Jose' + String.fromCodePoint(0x301);
    expect(UpdateProfileSchema.parse({ displayName: decomposed }).displayName).toBe('Jos' + String.fromCodePoint(0xe9));
    expect(cleanDisplayName(' a  b ')).toBe('a b');
  });

  it('rechaza lo que queda vacío o corto tras limpiar', () => {
    expect(parse('   ').success).toBe(false);
    expect(parse(' A ').success).toBe(false);
  });

  it('rechaza invisibles y bidi: ancho cero, RLO, joiner, Hangul filler, braille en blanco, separadores de línea y párrafo', () => {
    const bad = [0x200b, 0x202e, 0x200d, 0x2066, 0xfeff, 0x3164, 0x2800, 0x115f, 0x1160, 0x2028, 0x2029];
    for (const cp of bad) {
      const name = 'Ma' + String.fromCodePoint(cp) + 'ria';
      expect(parse(name).success, cp.toString(16)).toBe(false);
      expect(hasInvisibleChars(name) || cp === 0x2028 || cp === 0x2029).toBe(true);
    }
    // Un nombre hecho solo de invisibles no es un nombre.
    expect(parse(String.fromCodePoint(0x3164, 0x3164, 0x3164)).success).toBe(false);
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
