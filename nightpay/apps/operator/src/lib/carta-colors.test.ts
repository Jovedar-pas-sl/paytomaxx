import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SECTION_CODES } from '@nightpay/contracts';
import { cartaTileColor } from './carta-tiles';
import { PROPINAS } from './cuenta';

// Grafito 2: la carta del personal con color vivo. Cada loseta, del color
// sólido de su sección y con el texto en tinta (--np-on-section); antes, el
// 26 % del color sobre la superficie con texto crema (se veía apagado).

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const STYLES = read('../../../../packages/ui/src/styles.css');
const COBRAR = read('../components/cobrar/cobrar.module.css');
const CARTA = read('../components/cobrar/Carta.tsx');

/** El bloque de una regla que empieza la línea con ese selector (lo de dentro de sus llaves), la primera. */
function block(css: string, selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`no está ${selector}`);
  return css.slice(at, css.indexOf('}', at));
}

const ROOT = block(STYLES, ':root');

/** Todas las --np-sec-* de :root con su valor (las de sección y los tonos de loseta). */
const SECTION_VARS = Object.fromEntries(
  [...ROOT.matchAll(/(--np-sec-[a-z-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1]!, m[2]!.toLowerCase()]),
);
const INK = ROOT.match(/--np-on-section:\s*(#[0-9a-fA-F]{6})/)?.[1]?.toLowerCase() ?? '';

/** Contraste WCAG entre dos colores hex. */
function contrast(a: string, b: string): number {
  const lum = (hex: string): number => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('la tinta sobre el color de cada sección (Grafito 2)', () => {
  it('styles.css define la tinta y todas las secciones (y los dos tonos de loseta)', () => {
    expect(INK).toBe('#0f1112');
    expect(Object.keys(SECTION_VARS)).toEqual(
      expect.arrayContaining([
        '--np-sec-copas',
        '--np-sec-habitaciones',
        '--np-sec-comida',
        '--np-sec-servicios',
        '--np-sec-entradas',
        '--np-sec-propinas',
        '--np-sec-saldo',
        '--np-sec-otros',
        '--np-sec-servicios-tile',
        '--np-sec-propinas-tile',
      ]),
    );
  });

  it('el texto en tinta se lee sobre todas las --np-sec-* (≥ 4,5:1)', () => {
    for (const [name, hex] of Object.entries(SECTION_VARS)) {
      expect(contrast(INK, hex), name).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('cada loseta de la carta (todas las secciones y las propinas) usa una --np-sec-* que existe y se lee', () => {
    for (const section of [...SECTION_CODES, PROPINAS]) {
      const name = cartaTileColor(section).match(/^var\((--np-sec-[a-z-]+)\)$/)?.[1];
      expect(name, section).toBeDefined();
      expect(SECTION_VARS[name!], `${section} → ${name}`).toBeDefined();
      expect(contrast(INK, SECTION_VARS[name!]!), section).toBeGreaterThanOrEqual(4.5);
    }
    // Servicios y Propinas, en su tono de loseta (un punto más claro).
    expect(cartaTileColor('CHICA_SERVICE')).toBe('var(--np-sec-servicios-tile)');
    expect(cartaTileColor(PROPINAS)).toBe('var(--np-sec-propinas-tile)');
    expect(cartaTileColor('VENUE_BAR')).toBe('var(--np-sec-copas)');
  });

  it('el modo «sala» no cambia las secciones ni la tinta: las losetas se ven igual', () => {
    const sala = block(STYLES, "html[data-contrast='sala']");
    expect(sala).not.toMatch(/--np-sec-|--np-on-section/);
  });
});

describe('la loseta en cobrar.module.css', () => {
  it('color sólido de la sección y texto en tinta (sin el tinte del 26 %)', () => {
    const tile = block(COBRAR, '.tile');
    expect(tile).toMatch(/background: var\(--c\);/);
    expect(tile).toMatch(/color: var\(--np-on-section\);/);
    expect(tile).toMatch(/border-radius: var\(--np-r-tile\);/);
    expect(COBRAR).not.toMatch(/color-mix\(in srgb, var\(--c\)/);
  });

  it('la elegida: anillo de tinta de 3 px y el contador en tinta, que se ven sobre el color', () => {
    expect(block(COBRAR, '.tileOn')).toMatch(/box-shadow: inset 0 0 0 3px var\(--np-on-section\);/);
    expect(block(COBRAR, '.count')).toMatch(/background: var\(--np-on-section\);/);
    // Un anillo (no texto) pide 3:1 con lo de al lado; la tinta da ≥ 4,5 sobre todas.
    for (const [name, hex] of Object.entries(SECTION_VARS)) expect(contrast(INK, hex), name).toBeGreaterThanOrEqual(3);
  });

  it('nombre en 500, precio en 600; «Otro importe» neutro y con filete', () => {
    expect(block(COBRAR, '.tileName')).toMatch(/font: 500 /);
    expect(block(COBRAR, '.price')).toMatch(/font: 600 /);
    const other = block(COBRAR, '.tileOther');
    expect(other).toMatch(/background: var\(--np-surface-2\);/);
    expect(other).toMatch(/box-shadow: inset 0 0 0 1px var\(--np-border-hi\);/);
  });

  it('Carta.tsx pinta las losetas y las propinas con cartaTileColor (el título del grupo, con su punto)', () => {
    expect(CARTA).toMatch(/'--c': cartaTileColor\(item\.category\)/);
    expect(CARTA).toMatch(/'--c': cartaTileColor\(PROPINAS\)/);
    expect(CARTA).toMatch(/className=\{styles\.group\} style=\{\{ '--c': colorOf\(group\.section\) \}/);
  });
});
