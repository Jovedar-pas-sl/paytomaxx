import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Colores con más vida del panel (styles/panel-vivo.css): el texto de cada
 * cifra de «Esta noche» y de «Cómo pagó» se lee (≥ 4,5:1) sobre su tarjeta
 * tintada, en los dos temas. Se mezcla el color con la superficie como lo hace
 * el CSS (color-mix) y se calcula el contraste WCAG.
 */

const read = (url: URL): string => readFileSync(url, 'utf8').replace(/\r\n/g, '\n');
const UI = read(new URL('../../../../packages/ui/src/styles.css', import.meta.url));
const VIVO = read(new URL('../styles/panel-vivo.css', import.meta.url));

function vars(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no está ${selector}`);
  const body = css.slice(start, css.indexOf('\n}', start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim().toLowerCase();
  return out;
}

const DARK = { ...vars(UI, ":root,\n[data-theme='dark']"), ...vars(VIVO, ":root,\n[data-theme='dark']") };
const LIGHT = { ...DARK, ...vars(UI, "[data-theme='light']"), ...vars(VIVO, "[data-theme='light']") };

function hex(theme: Record<string, string>, name: string, depth = 0): string {
  const v = theme[name];
  if (!v || depth > 6) throw new Error(`no está ${name}`);
  const ref = v.match(/^var\((--[a-z0-9-]+)\)$/);
  return ref ? hex(theme, ref[1]!, depth + 1) : v;
}

const lum = (h: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
const mix = (a: string, b: string, pct: number): string =>
  '#' + [1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * (pct / 100) + parseInt(b.slice(i, i + 2), 16) * (1 - pct / 100)).toString(16).padStart(2, '0')).join('');

describe.each([
  ['oscuro', DARK],
  ['claro', LIGHT],
] as const)('panel con más vida, tema %s', (_name, theme) => {
  const tint = parseInt(theme['--vv-tint']!, 10);
  const surface = hex(theme, '--np-surface');
  it.each(['--vv-ok', '--vv-card', '--vv-pay', '--vv-warn'])('la cifra %s se lee sobre su tarjeta (≥ 4,5:1)', (token) => {
    const c = hex(theme, token);
    expect(ratio(c, mix(c, surface, tint))).toBeGreaterThanOrEqual(4.5);
  });
  it.each(['--vv-how-card', '--vv-how-saldo', '--vv-how-cash', '--vv-how-pos'])('el icono %s se ve sobre su cuadrito (≥ 3:1)', (token) => {
    const c = hex(theme, token);
    expect(ratio(c, mix(c, surface, 22))).toBeGreaterThanOrEqual(3);
  });
});

describe('forma de las reglas', () => {
  it('el tinte es más suave en claro que en oscuro', () => {
    expect(parseInt(LIGHT['--vv-tint']!, 10)).toBeLessThan(parseInt(DARK['--vv-tint']!, 10));
  });
  it('la franja de la fila es de 4 px y la del móvil, el borde izquierdo de la tarjeta', () => {
    expect(VIVO).toMatch(/inset 4px 0 0 var\(--np-row/);
    expect(VIVO).toMatch(/border-left: 4px solid var\(--np-row/);
  });
});
