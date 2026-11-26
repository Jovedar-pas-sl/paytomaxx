import { describe, expect, it } from 'vitest';
import { PAY_LANGUAGES, languageLocale } from '../customer-lang';
import { CLIENT_ERROR_KEYS, CUSTOMER_TEXT } from './index';
import { frenchSpacing } from './typography';

/**
 * Las traducciones de las páginas del cliente están completas: la misma forma
 * que el castellano (es.ts) en cada idioma, nada vacío, los mismos {huecos},
 * traducidas de verdad (no copiadas) y sin el vocabulario de la app del personal.
 */

type Leaf = { path: string; kind: 'string' | 'function' | 'boolean'; text: string };

/** Cada texto con su ruta; las funciones, con un argumento de ejemplo que se tiene que ver. */
function leaves(value: unknown, at = ''): Leaf[] {
  if (typeof value === 'string') return [{ path: at, kind: 'string', text: value }];
  if (typeof value === 'boolean') return [{ path: at, kind: 'boolean', text: String(value) }];
  if (typeof value === 'function') {
    return [{ path: at, kind: 'function', text: String((value as (x: string) => unknown)('ARG1')) }];
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => leaves(v, at ? `${at}.${k}` : k));
  }
  return [{ path: at, kind: 'string', text: `<<${typeof value}>>` }];
}

const placeholders = (s: string): string[] => [...s.matchAll(/\{[a-z]+\}/g)].map((m) => m[0]).sort();
const byPath = (lang: (typeof PAY_LANGUAGES)[number]): Map<string, Leaf> =>
  new Map(leaves(CUSTOMER_TEXT[lang]).map((l) => [l.path, l]));

const ES = byPath('es');
const OTHERS = PAY_LANGUAGES.filter((l) => l !== 'es');

/** Lo que es igual en todos los idiomas (marcas, siglas, cifras). */
const SAME_EVERYWHERE = new Set([
  'pay.htmlLang',
  'pay.locale',
  'wallet.htmlLang',
  'wallet.locale',
  'pay.total',
  'pay.bitcoin.rate',
  'pay.receipt.date',
  'pay.receipt.code',
  'pay.methods',
  'pay.receipt.wallet',
  'wallet.pinLabel',
  'wallet.topUpLimits',
  'wallet.balanceOf',
  'wallet.steps.0',
  'pay.receipt.authCode',
  'pay.receipt.order',
  'pay.unlock.ios.button',
  'pay.unlock.ios.done',
  'pay.languageMenu',
  'pay.breakdown.consumption',
  'pay.breakdown.topUp',
  'pay.receipt.topUp',
  'pay.totalToPay',
  'pay.youPay',
  'pay.payPrefix',
  'wallet.pay',
  'wallet.mv.topUp',
  'wallet.cancel',
  'wallet.balance',
  'wallet.more',
  'wallet.proofWhat',
  'wallet.lostGo',
  'payout.button',
  'pay.busyTitle',
  'pay.unlock.ios.title',
  'pay.receipt.method',
  'pay.agoUnits.min',
  'pay.agoUnits.h',
  'pay.agoUnits.d',
  'wallet.detail.total',
]);

/** Iguales en portugués y en castellano porque se dicen igual. */
const SAME_IN_PT = new Set([
  'pay.receipt.total',
  'wallet.mergeRow',
  'wallet.pinDone',
  'wallet.pinSave',
  'wallet.topUpGoFee',
  'wallet.detail.canceled',
  // «a Sala Aurora»: la misma preposición.
  'pay.paidTo',
  // La página del saldo (idea 69): se dicen igual.
  'wallet.last',
  'wallet.movementsAll',
  'wallet.movementsLess',
  'wallet.lostQuick',
]);

/** «hace » / « ago»: vacíos en algún idioma por cómo se dice. */
const MAY_BE_EMPTY = new Set(['pay.agoPrefix', 'pay.agoSuffix']);

describe('traducciones de las páginas del cliente', () => {
  it('cuatro idiomas: español, inglés, francés y portugués', () => {
    expect(Object.keys(CUSTOMER_TEXT).sort()).toEqual(['en', 'es', 'fr', 'pt']);
    for (const lang of PAY_LANGUAGES) {
      expect(CUSTOMER_TEXT[lang].pay.htmlLang).toBe(lang);
      expect(CUSTOMER_TEXT[lang].wallet.htmlLang).toBe(lang);
      expect(CUSTOMER_TEXT[lang].pay.locale).toBe(languageLocale(lang));
      expect(CUSTOMER_TEXT[lang].wallet.locale).toBe(languageLocale(lang));
    }
  });

  it.each(OTHERS)('%s: ni falta ni sobra ninguna clave del castellano (y del mismo tipo)', (lang) => {
    const other = byPath(lang);
    expect([...other.keys()].sort()).toEqual([...ES.keys()].sort());
    for (const [path, leaf] of ES) expect(`${path}:${other.get(path)?.kind}`).toBe(`${path}:${leaf.kind}`);
  });

  it.each(PAY_LANGUAGES)('%s: ningún texto vacío (salvo los que también lo están en castellano)', (lang) => {
    const empty = leaves(CUSTOMER_TEXT[lang]).filter(
      (l) => l.text.trim() === '' && ES.get(l.path)?.text !== '' && !MAY_BE_EMPTY.has(l.path),
    );
    expect(empty.map((l) => l.path)).toEqual([]);
  });

  it.each(OTHERS)('%s: los mismos {huecos} que rellena la página', (lang) => {
    const other = byPath(lang);
    const wrong = [...ES].filter(([path, l]) => placeholders(l.text).join() !== placeholders(other.get(path)?.text ?? '').join());
    expect(wrong.map(([path]) => path)).toEqual([]);
  });

  it.each(PAY_LANGUAGES)('%s: las frases con importe, hora o nombre los llevan dentro', (lang) => {
    const missing = leaves(CUSTOMER_TEXT[lang]).filter((l) => l.kind === 'function' && !l.text.includes('ARG1'));
    expect(missing.map((l) => l.path)).toEqual([]);
  });

  it.each(['fr', 'pt'] as const)('%s: traducido de verdad (no se queda en castellano ni en inglés)', (lang) => {
    const en = byPath('en');
    const copied = leaves(CUSTOMER_TEXT[lang]).filter(
      (l) =>
        l.kind !== 'boolean' &&
        l.text.trim() !== '' &&
        !SAME_EVERYWHERE.has(l.path) &&
        !(lang === 'pt' && SAME_IN_PT.has(l.path)) &&
        (l.text === ES.get(l.path)?.text || l.text === en.get(l.path)?.text),
    );
    expect(copied.map((l) => `${l.path} = ${l.text}`)).toEqual([]);
  });

  it('inglés: traducido (no se queda en castellano)', () => {
    const copied = leaves(CUSTOMER_TEXT.en).filter(
      (l) => l.kind !== 'boolean' && l.text.trim() !== '' && !SAME_EVERYWHERE.has(l.path) && l.text === ES.get(l.path)?.text,
    );
    expect(copied.map((l) => `${l.path} = ${l.text}`)).toEqual([]);
  });

  it.each(PAY_LANGUAGES)('%s: sin el vocabulario de la app del personal ni nombres internos', (lang) => {
    const internal = /\bchicas?\b|habitaci|operador|masaje|dat[aá]fono|\btpv\b|\bterminal\b|oxiopay|\bwallets?\b(?! ?\.)|saldo oxio/i;
    const bad = leaves(CUSTOMER_TEXT[lang]).filter((l) => internal.test(l.text.replace(/Google Wallet/g, '')));
    expect(bad.map((l) => `${l.path} = ${l.text}`)).toEqual([]);
  });

  it.each(OTHERS)('%s: Apple Pay, Google Pay, Face ID y Google Wallet sin traducir, donde los dice el castellano', (lang) => {
    const other = byPath(lang);
    const brands = ['Apple Pay', 'Google Pay', 'Face ID', 'Google Wallet'];
    const lost = [...ES].flatMap(([path, l]) =>
      brands.filter((b) => l.text.includes(b) && !(other.get(path)?.text ?? '').includes(b)).map((b) => `${path}: ${b}`),
    );
    expect(lost).toEqual([]);
  });

  it('los errores del API: los mismos codes en los cuatro idiomas', () => {
    for (const lang of PAY_LANGUAGES) {
      expect(Object.keys(CUSTOMER_TEXT[lang].errors).sort()).toEqual([...CLIENT_ERROR_KEYS].sort());
    }
  });

  it('francés: espacios irrompibles antes de « : ; ! ? » y dentro de las comillas', () => {
    const NBSP = String.fromCharCode(0xa0);
    const NNBSP = String.fromCharCode(0x202f);
    expect(frenchSpacing('Payer ? Oui ! « Autre » : non')).toBe(`Payer${NNBSP}? Oui${NNBSP}! «${NBSP}Autre${NBSP}»${NBSP}: non`);
    const fr = leaves(CUSTOMER_TEXT.fr);
    expect(fr.filter((l) => / [:;!?»]|« /.test(l.text)).map((l) => l.path)).toEqual([]);
    expect(CUSTOMER_TEXT.fr.pay.feeWhat).toBe(`C’est quoi${NNBSP}?`);
    expect(CUSTOMER_TEXT.fr.pay.openingWallet('Apple Pay')).toBe('Ouverture d’Apple Pay…');
    expect(CUSTOMER_TEXT.fr.pay.openingWallet('Google Pay')).toBe('Ouverture de Google Pay…');
  });
});
