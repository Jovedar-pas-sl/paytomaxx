import { describe, expect, it } from 'vitest';
import { CUENTA_BASICA, CUENTA_BASICA_SOURCES } from './cuenta-basica';

const text = CUENTA_BASICA.map((s) => [s.title, ...s.points].join(' ')).join(' ');

describe('la guía de la cuenta de pago básica dice lo que pidió el dueño', () => {
  it('qué es, quién tiene derecho, qué llevar, cuánto cuesta, cuándo contestan y cómo reclamar', () => {
    expect(CUENTA_BASICA.map((s) => s.id)).toEqual(['que-es', 'derecho', 'papeles', 'cuesta', 'plazo', 'reclamar']);
  });

  it('con los datos de la ley: residentes legales y asilo, 3 € al mes, 10 días hábiles, por escrito y el Banco de España', () => {
    expect(text).toContain('vive legalmente');
    expect(text).toContain('asilo');
    expect(text).toContain('Real Decreto-ley 19/2017');
    expect(text).toContain('3 € al mes');
    expect(text).toContain('10 días hábiles');
    expect(text).toContain('por escrito');
    expect(text).toContain('Banco de España');
    expect(CUENTA_BASICA_SOURCES).toMatch(/Orden ETD\/699\/2020/);
  });

  it('en lenguaje del personal: sin «chica»', () => {
    expect(text.toLowerCase()).not.toContain('chica');
  });
});
