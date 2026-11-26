import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Letra mínima de las páginas del cliente (idea 65): nada por debajo de 14 px,
 * tampoco en pantallas bajas. De noche y con una copa, 12 px no se lee. Mira el
 * CSS que va dentro de los `.ts` de las páginas que pinta el API: cada
 * `font-size`, el tamaño de cada `font:` y el mínimo de cada `clamp()`.
 *
 * Única excepción: la marquesina antifraude del «Pagado» (`.band>span`), que es
 * un adorno que se mueve y repite lo que ya dice la pantalla en grande.
 * `party/` no entra: es otra edición, con su propia entrega.
 */

const MODULES = join(__dirname, '..');
const DIRS = ['payments', 'wallets', 'legal', 'home-topup', 'btcpay', 'reservations'];
const MIN_PX = 14;
const EXCEPT = new Set(['.band>span']);

interface Size {
  where: string;
  selector: string;
  value: string;
  /** null: no es un tamaño que se pueda leer aquí (p. ej. var()): hay que mirarlo a mano. */
  px: number | null;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(join(MODULES, dir), { recursive: true, encoding: 'utf8' })
    .map((f) => f.replace(/\\/g, '/'))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
    .map((f) => `${dir}/${f}`);
}

/** «.875rem», «14px» o el mínimo de «clamp(2.5rem,12vw,3rem)», en px. */
function px(value: string): number | null {
  const v = value.trim();
  const first = v.startsWith('clamp(') ? (v.slice(6).split(',')[0] ?? '') : v;
  const m = /^([0-9]*\.?[0-9]+)(rem|px)$/.exec(first.trim());
  return m ? Number(m[1]) * (m[2] === 'rem' ? 16 : 1) : null;
}

/** El selector de la regla que contiene la posición `at`. */
function selectorAt(text: string, at: number): string {
  const open = text.lastIndexOf('{', at);
  const start = Math.max(text.lastIndexOf('}', open), text.lastIndexOf('{', open - 1), text.lastIndexOf('`', open), text.lastIndexOf('\n', open));
  return text.slice(start + 1, open).trim();
}

function sizesOf(file: string): Size[] {
  const text = readFileSync(join(MODULES, file), 'utf8');
  const found: Size[] = [];
  for (const m of text.matchAll(/font-size:\s*([^;}"'`]+)/g)) {
    found.push({ where: file, selector: selectorAt(text, m.index), value: m[1]!.trim(), px: px(m[1]!) });
  }
  // font: 400 16px/1.5 var(--sans) → «16px». `font:inherit` no fija tamaño.
  for (const m of text.matchAll(/(?<![-\w])font:\s*([^;}"'`]+)/g)) {
    const value = m[1]!.trim();
    if (value === 'inherit') continue;
    const size = /(?:^|\s)([0-9]*\.?[0-9]+(?:rem|px))(?:\/|\s|$)/.exec(value)?.[1];
    found.push({ where: file, selector: selectorAt(text, m.index), value, px: size ? px(size) : null });
  }
  return found;
}

const SIZES = DIRS.flatMap(sourceFiles).flatMap(sizesOf);

describe('letra mínima de las páginas del cliente: 14 px', () => {
  it('lee los tamaños de verdad (no pasa por no encontrar nada)', () => {
    expect(SIZES.length).toBeGreaterThan(150);
    expect(px('.875rem')).toBe(14);
    expect(px('clamp(.75rem,3vw,1rem)')).toBe(12);
    expect(px('16px')).toBe(16);
    expect(px('var(--x)')).toBeNull();
    // La excepción existe y sigue siendo pequeña: si deja de serlo, sobra aquí.
    const band = SIZES.filter((s) => EXCEPT.has(s.selector));
    expect(band.map((s) => s.where)).toEqual(['payments/paid-screen.ts']);
    expect(band[0]?.px).toBeLessThan(MIN_PX);
  });

  it('ningún tamaño que no se pueda leer (var(), calc(), em…): se escribe en rem o px', () => {
    expect(SIZES.filter((s) => s.px === null).map((s) => `${s.where} ${s.selector} → ${s.value}`)).toEqual([]);
  });

  it('nada por debajo de 14 px, también en pantallas bajas, en font: y en el mínimo de clamp()', () => {
    const small = SIZES.filter((s) => s.px !== null && s.px < MIN_PX && !EXCEPT.has(s.selector));
    expect(small.map((s) => `${s.where} ${s.selector} → ${s.value}`)).toEqual([]);
  });
});
