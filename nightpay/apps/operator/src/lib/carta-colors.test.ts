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
    expect(INK).toBe('#0b0d0e');
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
  it('degradado de 150° del color de la sección, brillo debajo, línea clara arriba y texto en tinta', () => {
    const tile = block(COBRAR, '.tile');
    expect(tile).toMatch(/background: linear-gradient\(150deg, color-mix\(in srgb, var\(--c\) 62%, #fff\) 0%, var\(--c\) 58%\);/);
    expect(tile).toMatch(/box-shadow: 0 8px 22px -8px color-mix\(in srgb, var\(--c\) var\(--np-tile-glow\), transparent\), inset 0 1px 0 var\(--np-tile-hi\);/);
    expect(tile).toMatch(/color: var\(--np-on-section\);/);
    expect(tile).toMatch(/border-radius: var\(--np-r-tile\);/);
    // Ya no es el tinte del 26 % sobre la superficie: el color entra en el degradado.
    expect(COBRAR).not.toMatch(/color-mix\(in srgb, var\(--c\) 26%/);
  });

  it('la elegida: brilla más y lleva un aro fino claro; el contador en tinta se ve sobre el color', () => {
    const on = block(COBRAR, '.tileOn');
    expect(on).toMatch(/var\(--np-tile-glow-on\)/);
    expect(on).toMatch(/inset 0 0 0 2px rgb\(255 255 255 \/ 0\.9\)/);
    expect(block(COBRAR, '.count')).toMatch(/background: var\(--np-on-section\);/);
    // Un anillo (no texto) pide 3:1 con lo de al lado; la tinta da ≥ 4,5 sobre todas.
    for (const [name, hex] of Object.entries(SECTION_VARS)) expect(contrast(INK, hex), name).toBeGreaterThanOrEqual(3);
  });

  it('nombre en 500, precio en 600; «Otro importe» neutro y con filete', () => {
    // Grafito 3: nombre a 14 con peso 500; precio a 16 en Manrope 700.
    expect(block(COBRAR, '.tileName')).toMatch(/font: 500 var\(--np-fs-14\)/);
    expect(block(COBRAR, '.price')).toMatch(/font: 700 var\(--np-fs-16\)/);
    const other = block(COBRAR, '.tileOther');
    expect(other).toMatch(/background: var\(--np-surface-2\);/);
    expect(other).toMatch(/box-shadow: inset 0 0 0 1px var\(--np-border-hi\);/);
  });

  it('Carta.tsx pinta las losetas con cartaTileColor (el título del grupo, con su punto); sin losetas de propina (B1)', () => {
    expect(CARTA).toMatch(/'--c': cartaTileColor\(item\.category\)/);
    // B1: la propina la elige el cliente al pagar; en Cobrar no se añade.
    expect(CARTA).not.toMatch(/cartaTileColor\(PROPINAS\)/);
    expect(CARTA).not.toContain('onTip');
    expect(CARTA).toMatch(/className=\{styles\.group\} style=\{\{ '--c': colorOf\(group\.section\) \}/);
  });
});

describe('el brillo de la carta (colores con más vida)', () => {
  // «Color y relieve» (25-nov-2026): el brillo lima de «Cobrar» ya no es una
  // ficha aparte (--np-primary-glow, al 70 %) puesta solo en el pie de la carta:
  // va dentro del relieve del botón principal (--np-primary-shadow, al 50 %),
  // el mismo en todos los botones principales.
  it('oscuro: del color al 75 %, línea clara de 0,45 y brillo lima en «Cobrar» (el del botón principal)', () => {
    expect(ROOT).toMatch(/--np-tile-glow:\s*75%/);
    expect(ROOT).toMatch(/--np-tile-hi:\s*rgb\(255 255 255 \/ 0\.45\)/);
    const dark = block(STYLES, ":root,\n[data-theme='dark']");
    expect(dark).toMatch(/--np-primary-shadow:[^;]*0 8px 24px -8px rgba\(199, 211, 1, 0\.5\);/);
    expect(block(COBRAR, '.primary')).toMatch(/box-shadow: var\(--np-primary-shadow\);/);
    expect(STYLES).not.toContain('--np-primary-glow');
    expect(COBRAR).not.toContain('--np-primary-glow');
  });

  it('claro: sin brillo de color fuerte (sombra suave)', () => {
    const light = block(STYLES, "[data-theme='light']");
    const glow = Number(light.match(/--np-tile-glow:\s*(\d+)%/)?.[1]);
    expect(glow).toBeGreaterThan(0);
    expect(glow).toBeLessThanOrEqual(35);
    const shadow = light.match(/--np-primary-shadow:([^;]*);/)?.[1] ?? '';
    expect(shadow).toContain('rgba(21, 25, 28,');
    expect(shadow).not.toMatch(/199[ ,]+211[ ,]+1\b/);
  });

  it('sin animación nueva en la loseta', () => {
    expect(block(COBRAR, '.tile')).not.toMatch(/animation:/);
    expect(block(COBRAR, '.tileOn')).not.toMatch(/animation:/);
  });

  it('el contador ×N no pisa el nombre y el punto del título brilla', () => {
    expect(block(COBRAR, '.tiles > .tile .tileNameBadge')).toMatch(/padding-right: 0;/);
    expect(block(COBRAR, '.group::before')).toMatch(/box-shadow: 0 0 8px var\(--c\);/);
  });
});
