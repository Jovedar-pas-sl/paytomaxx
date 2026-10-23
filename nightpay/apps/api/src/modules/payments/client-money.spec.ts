import { describe, expect, it } from 'vitest';
import { formatMoney } from '@nightpay/contracts';
import { MONEY_JS, clientMoney } from './club-ui';

/**
 * Un solo formato de importes para el cliente (decisión D4): «33 €» sin
 * «,00» (como en el móvil del personal), miles con punto y «−12 €» con el
 * signo menos de verdad. Lo que pinta el servidor y lo que pinta el JS de la
 * página al cambiar la propina o el saldo tiene que ser lo mismo.
 */
const plain = (s: string): string => s.replace(/\u00a0/g, ' ');

// El JS de las páginas, ejecutado aquí (es una función sin dependencias).
const npMoney = new Function(`${MONEY_JS}; return npMoney;`)() as (c: number, L: string, cur?: string, full?: boolean) => string;

describe('formatMoney (contracts)', () => {
  it('sin «,00» cuando se pide compacto; con céntimos si los hay', () => {
    expect(plain(formatMoney(3300, { compact: true }))).toBe('33 €');
    expect(plain(formatMoney(3350, { compact: true }))).toBe('33,50 €');
    expect(plain(formatMoney(3300))).toBe('33,00 €');
  });

  it('miles siempre con punto (es-ES no agrupa 4 cifras por defecto)', () => {
    expect(plain(formatMoney(110_900, { compact: true }))).toBe('1.109 €');
    expect(plain(formatMoney(123_456))).toBe('1.234,56 €');
    expect(plain(formatMoney(12_345_600, { compact: true }))).toBe('123.456 €');
  });

  it('negativos con el signo menos de verdad (U+2212)', () => {
    expect(plain(formatMoney(-1200, { compact: true }))).toBe('−12 €');
    expect(plain(formatMoney(-50))).toBe('−0,50 €');
  });

  it('en inglés, como se escribe allí', () => {
    expect(formatMoney(3300, { compact: true, locale: 'en-GB' })).toBe('€33');
    expect(formatMoney(110_950, { locale: 'en-GB' })).toBe('€1,109.50');
  });

  it('una moneda que Intl no conoce sale como cifra y código, sin romper', () => {
    expect(plain(formatMoney(1200, { currency: 'X1' }))).toBe('12,00 X1');
  });

  it('solo la cifra (la moneda va aparte), con los mismos miles y signo', () => {
    expect(formatMoney(123_456, { bare: true })).toBe('1.234,56');
    expect(formatMoney(-50, { bare: true })).toBe('−0,50');
    expect(formatMoney(150, { bare: true, currency: 'X1' })).toBe('1,50');
  });

  it('nunca redondea: compacto solo quita los «,00»', () => {
    expect(plain(formatMoney(1250, { compact: true }))).toBe('12,50 €');
    expect(plain(formatMoney(1299, { compact: true }))).toBe('12,99 €');
  });
});

describe('clientMoney y npMoney (las páginas del cliente) dicen lo mismo', () => {
  const values = [0, 5, 200, 3300, 3350, 110_900, 123_456, -1200, -50];
  it.each(['es-ES', 'en-GB'])('%s: el HTML y el JS de la página, iguales', (locale) => {
    for (const c of values) {
      expect(npMoney(c, locale, 'EUR'), `${c}`).toBe(clientMoney(c, locale));
      expect(npMoney(c, locale, 'EUR', true), `${c} con céntimos`).toBe(clientMoney(c, locale, 'EUR', true));
    }
  });

  it('el cliente ve «33 €» (D4) y el justificante, con céntimos', () => {
    expect(plain(clientMoney(3300, 'es-ES'))).toBe('33 €');
    expect(plain(clientMoney(3300, 'es-ES', 'EUR', true))).toBe('33,00 €');
  });

  it('el JS de la página no lleva barras invertidas (va dentro de una plantilla)', () => {
    expect(MONEY_JS.includes(String.fromCharCode(92))).toBe(false);
  });
});
