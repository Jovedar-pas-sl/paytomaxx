import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CARD_MARKS } from '../modules/payments/pay-marks';

/**
 * La portada (web-client) con dos puertas (idea 73): «Ver mi saldo» (lima) a
 * GET /w/mine del API y «Tengo un local» (secundario) a #locales. Debajo, las
 * marcas con las que se paga, a 28 px: Visa y Mastercard (las mismas de /pay,
 * CARD_MARKS) y la de Apple Pay, el fichero oficial sin tocar. Se lee como
 * texto, como textos-saldo.spec.ts: web-client no tiene pruebas propias.
 */

const ROOT = join(__dirname, '..', '..', '..', '..');
const read = (...rel: string[]): string => readFileSync(join(ROOT, ...rel), 'utf8').replace(/\r\n/g, '\n');
const PORTADA = 'apps/web-client/src/app/_portada';
const MARCAS = 'apps/web-client/public/portada/marcas';
const HERO = read(PORTADA, 'Hero.tsx');
const CSS = read(PORTADA, 'hero.module.css');

/** El cuerpo de la primera regla con ese selector exacto (desde `from`). */
function rule(css: string, selector: string, from = 0): string {
  const start = css.indexOf(`${selector} {`, from);
  if (start < 0) throw new Error(`no está ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

const sha256 = (rel: string): string => createHash('sha256').update(readFileSync(join(ROOT, MARCAS, rel))).digest('hex');

describe('portada: dos puertas', () => {
  it('«Ver mi saldo» en lima, a /w/mine del API; «Tengo un local», secundario, a #locales', () => {
    expect(HERO).toMatch(/<a className=\{cx\(s\.btn, s\.btnLime, s\.btnBig, h\.door\)\} href=\{myBalanceUrl\(\)\}>\s*Ver mi saldo\s*<\/a>/);
    expect(HERO).toMatch(/<a className=\{cx\(s\.btn, s\.btnLine, s\.btnBig, h\.door\)\} href="#locales">\s*Tengo un local\s*<\/a>/);
    // Primero el saldo (el cliente), luego el local.
    expect(HERO.indexOf('Ver mi saldo')).toBeLessThan(HERO.indexOf('Tengo un local'));
    expect(read('apps/web-client/src/lib/customer-pages.ts')).toMatch(/export function myBalanceUrl\(\): string \{\s*return `\$\{API_BASE\}\/w\/mine`;/);
    expect(read(PORTADA, 'sections.tsx')).toContain('<section id="locales"');
  });

  it('56 px de alto; apiladas en 360 y 390, lado a lado desde 480 px', () => {
    expect(read('apps/web-client/src/app/landing.module.css')).toMatch(/\.btnBig \{[^}]*min-height: 56px;/);
    expect(rule(CSS, '.doors')).toMatch(/flex-direction: column;/);
    const wide = CSS.indexOf('@media (min-width: 480px) {');
    expect(wide).toBeGreaterThan(0);
    expect(rule(CSS, '.doors', wide)).toMatch(/flex-direction: row;/);
    // Sin `gap` en flex (navegadores viejos): el hueco, con margen.
    expect(rule(CSS, '.doors')).not.toMatch(/\bgap:/);
  });
});

describe('portada: las marcas con las que se paga', () => {
  it('Visa y Mastercard: copia de las chapas de /pay (CARD_MARKS)', () => {
    const chapas = [...CARD_MARKS.matchAll(/<svg[^>]*>.*?<\/svg>/g)].map((m) => m[0].replace(' aria-hidden="true"', ''));
    expect(chapas).toHaveLength(2);
    const file = (name: string) => read(MARCAS, name).trim().replace(' xmlns="http://www.w3.org/2000/svg"', '');
    expect(file('visa.svg')).toBe(chapas[0]);
    expect(file('mastercard.svg')).toBe(chapas[1]);
  });

  it('Apple Pay: el fichero oficial, sin tocar', () => {
    expect(sha256('Apple_Pay_Mark_RGB_041619.svg')).toBe('66baf110b86c1f1ae01a0e28985970d3827465e6aba6be54d5142a6d1eaa803c');
  });

  it('Google Pay: el fichero oficial, sin tocar, en una caja de 52 px (su pastilla queda en 28)', () => {
    expect(sha256('google-pay-mark_800.svg')).toBe('9ddde73a0e3e8b16e7c518f00380c542c96dbec8b0f80363d5037d905f0bba9d');
    expect(HERO).toMatch(/<img className=\{h\.markBox\} src="\/portada\/marcas\/google-pay-mark_800\.svg" height=\{52\} alt="Google Pay" \/>/);
    expect(rule(CSS, '.markBox')).toMatch(/height: 52px;/);
    // Después de Apple Pay, la última.
    expect(HERO.indexOf('google-pay-mark_800.svg')).toBeGreaterThan(HERO.indexOf('Apple_Pay_Mark_RGB_041619.svg'));
  });

  it('a 28 px de alto, con su nombre para el lector; ninguna sale de otro dominio', () => {
    const marks = [...HERO.matchAll(/<img className=\{h\.mark\} src="([^"]+)" height=\{28\} alt="([^"]+)"/g)].map((m) => [m[1], m[2]]);
    expect(marks).toEqual([
      ['/portada/marcas/visa.svg', 'Visa'],
      ['/portada/marcas/mastercard.svg', 'Mastercard'],
      ['/portada/marcas/Apple_Pay_Mark_RGB_041619.svg', 'Apple Pay'],
    ]);
    for (const [src] of marks) expect(existsSync(join(ROOT, 'apps/web-client/public', src!))).toBe(true);
    expect(rule(CSS, '.mark')).toMatch(/height: 28px;/);
  });
});
