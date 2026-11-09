import { describe, expect, it } from 'vitest';
import { PAY_LANGUAGES } from '../payments/customer-lang';
import { HOME_TOPUP_ERROR_CODES, HOME_TOPUP_TEXT } from './home-topup-text';

/**
 * Los textos de «Cargar saldo antes de llegar», con las reglas de los del
 * cliente (payments/i18n/i18n.spec.ts): la misma forma que el castellano en
 * cada idioma, nada vacío, los mismos {huecos}, traducidos de verdad, sin el
 * vocabulario de la app del personal y con las marcas sin traducir.
 */

type Leaf = { path: string; text: string };

function leaves(value: unknown, at = ''): Leaf[] {
  if (typeof value === 'string') return [{ path: at, text: value }];
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => leaves(v, at ? `${at}.${k}` : k));
  return [{ path: at, text: `<<${typeof value}>>` }];
}

const byPath = (lang: (typeof PAY_LANGUAGES)[number]) => new Map(leaves(HOME_TOPUP_TEXT[lang]).map((l) => [l.path, l.text]));
const ES = byPath('es');
const OTHERS = PAY_LANGUAGES.filter((l) => l !== 'es');
const placeholders = (s: string): string => [...s.matchAll(/\{[a-z]+\}/g)].map((m) => m[0]).sort().join();
/** Lo que se dice igual en portugués (o en todos). */
const SAME = new Set(['goFee', 'conditionsTitle']);

describe('textos de «Cargar saldo antes de llegar»', () => {
  it('cuatro idiomas', () => {
    expect(Object.keys(HOME_TOPUP_TEXT).sort()).toEqual(['en', 'es', 'fr', 'pt']);
  });

  it.each(OTHERS)('%s: ni falta ni sobra ninguna clave', (lang) => {
    expect([...byPath(lang).keys()].sort()).toEqual([...ES.keys()].sort());
  });

  it.each(PAY_LANGUAGES)('%s: nada vacío', (lang) => {
    expect(leaves(HOME_TOPUP_TEXT[lang]).filter((l) => l.text.trim() === '').map((l) => l.path)).toEqual([]);
  });

  it.each(OTHERS)('%s: los mismos {huecos} que rellena la página', (lang) => {
    const other = byPath(lang);
    expect([...ES].filter(([path, text]) => placeholders(text) !== placeholders(other.get(path) ?? '')).map(([p]) => p)).toEqual([]);
  });

  it.each(OTHERS)('%s: traducido de verdad (no se queda en castellano ni, fr y pt, en inglés)', (lang) => {
    const en = byPath('en');
    const copied = leaves(HOME_TOPUP_TEXT[lang]).filter(
      (l) => !SAME.has(l.path) && (l.text === ES.get(l.path) || (lang !== 'en' && l.text === en.get(l.path))),
    );
    expect(copied.map((l) => `${l.path} = ${l.text}`)).toEqual([]);
  });

  it.each(PAY_LANGUAGES)('%s: sin el vocabulario del personal ni nombres internos', (lang) => {
    // OxioPay no está: es el nombre del producto, el que ve el cliente.
    const internal = /\bchicas?\b|habitaci|operador|masaje|dat[aá]fono|\btpv\b|\bterminal\b|\bwallets?\b|webhook|idempotenc/i;
    expect(leaves(HOME_TOPUP_TEXT[lang]).filter((l) => internal.test(l.text)).map((l) => `${l.path} = ${l.text}`)).toEqual([]);
  });

  it.each(OTHERS)('%s: Apple Pay y Google Pay sin traducir donde los dice el castellano', (lang) => {
    const other = byPath(lang);
    const lost = [...ES].flatMap(([path, text]) =>
      ['Apple Pay', 'Google Pay'].filter((b) => text.includes(b) && !(other.get(path) ?? '').includes(b)).map((b) => `${path}: ${b}`),
    );
    expect(lost).toEqual([]);
  });

  it('los errores propios, en los cuatro idiomas', () => {
    for (const lang of PAY_LANGUAGES) expect(Object.keys(HOME_TOPUP_TEXT[lang].errors).sort()).toEqual([...HOME_TOPUP_ERROR_CODES].sort());
  });

  it('francés: espacios irrompibles antes de « : ; ! ? » y dentro de las comillas', () => {
    const fr = leaves(HOME_TOPUP_TEXT.fr);
    expect(fr.filter((l) => / [:;!?»]|« /.test(l.text)).map((l) => l.path)).toEqual([]);
    expect(HOME_TOPUP_TEXT.fr.amountLegend).toBe(`Combien voulez-vous charger${String.fromCharCode(0x202f)}?`);
  });

  it('las condiciones antes de pagar: no caduca y cómo se devuelve (lo que hace hoy «Me voy»)', () => {
    expect(HOME_TOPUP_TEXT.es.noExpiry).toContain('no caduca');
    expect(HOME_TOPUP_TEXT.es.refund).toContain('«Me voy»');
    // Se cargó con tarjeta: no sale en efectivo, y no lo hace el encargado.
    expect(HOME_TOPUP_TEXT.es.refund).toContain('a tu tarjeta');
    expect(HOME_TOPUP_TEXT.es.refund).not.toContain('efectivo');
    expect(HOME_TOPUP_TEXT.es.refund).not.toContain('encargado');
    expect(HOME_TOPUP_TEXT.es.refundFee).toContain('la comisión del servicio no se devuelve');
  });
});
