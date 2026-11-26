import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SECTION_BY_CODE,
  SECTION_FALLBACK_COLOR,
  SECTION_ON_COLOR,
  SECTION_TILE_COLORS,
  SECTIONS,
  sectionColor,
  sectionOf,
  sectionTileColor,
  sectionTileVar,
  sectionVar,
} from '@nightpay/ui';

const STYLES = readFileSync(new URL('../../../../packages/ui/src/styles.css', import.meta.url), 'utf8');
const LIME = '#c7d301';

/** Valor de una variable CSS de :root en styles.css (en minúsculas). */
function cssVar(name: string): string | null {
  const m = STYLES.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  return m ? m[1]!.toLowerCase() : null;
}

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

describe('colores de las secciones (marca OxioCard)', () => {
  it('cada categoría del cobro tiene su sección y su color', () => {
    // Los de «Color y relieve» (25-nov-2026).
    expect(sectionColor('VENUE_BAR')).toBe('#46efd4');
    expect(sectionColor('VENUE_ROOM')).toBe('#bbb8fe');
    expect(sectionColor('VENUE_FOOD')).toBe('#fd622d');
    expect(sectionColor('CHICA_SERVICE')).toBe('#ff77a2');
    expect(sectionColor('VENUE_ENTRY')).toBe('#4d94fb');
    expect(sectionColor('EXTRA')).toBe('#7c8893');
    expect(sectionOf('VENUE_BAR')?.label).toBe('Copas');
    expect(sectionVar('CHICA_SERVICE')).toBe('var(--np-sec-servicios)');
  });

  it('también por clave; el saldo va a trazos; lo desconocido, en gris (nunca lima)', () => {
    expect(sectionOf('copas')?.key).toBe('copas');
    expect(SECTIONS.saldo.dashed).toBe(true);
    expect(sectionOf('NO_EXISTE')).toBeNull();
    expect(sectionColor('NO_EXISTE')).toBe(SECTION_FALLBACK_COLOR);
    expect(sectionColor(null)).toBe(SECTION_FALLBACK_COLOR);
    expect(sectionVar(undefined)).toBe('var(--np-sec-otros)');
  });

  it('el lima es la marca, nunca una sección', () => {
    for (const s of Object.values(SECTIONS)) expect(s.color.toLowerCase()).not.toBe(LIME);
  });

  it('el mapa de TS y las variables --np-sec-* de styles.css dicen lo mismo', () => {
    for (const s of Object.values(SECTIONS)) {
      const name = s.cssVar.slice('var('.length, -1);
      expect(cssVar(name), name).toBe(s.color);
    }
    expect(cssVar('--np-sec-otros')).toBe(SECTION_FALLBACK_COLOR);
    expect(cssVar('--np-on-section')).toBe(SECTION_ON_COLOR);
    for (const key of Object.values(SECTION_BY_CODE)) expect(SECTIONS[key]).toBeDefined();
  });

  it('la tinta se lee sobre cualquier sección (≥ 4,5:1)', () => {
    for (const s of Object.values(SECTIONS)) expect(contrast(SECTION_ON_COLOR, s.color)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('tonos de loseta (con los colores vivos, iguales a los de la sección)', () => {
  it('las losetas de Servicios y Propinas llevan su color vivo; las demás, el suyo', () => {
    expect(sectionTileColor('CHICA_SERVICE')).toBe('#ff77a2');
    expect(sectionTileColor('propinas')).toBe('#feee82');
    expect(sectionTileVar('CHICA_SERVICE')).toBe('var(--np-sec-servicios-tile)');
    expect(sectionTileVar('propinas')).toBe('var(--np-sec-propinas-tile)');
    expect(sectionTileVar('VENUE_BAR')).toBe('var(--np-sec-copas)');
    expect(sectionTileColor('VENUE_FOOD')).toBe(sectionColor('VENUE_FOOD'));
    expect(sectionTileVar('NO_EXISTE')).toBe('var(--np-sec-otros)');
    expect(sectionTileColor(null)).toBe(SECTION_FALLBACK_COLOR);
  });

  it('los tonos de TS y --np-sec-*-tile de styles.css dicen lo mismo', () => {
    for (const [key, color] of Object.entries(SECTION_TILE_COLORS)) expect(cssVar(`--np-sec-${key}-tile`), key).toBe(color);
  });

  it('la etiqueta pequeña se lee sobre cada loseta (tinta oscura ≥ 4,5:1)', () => {
    for (const [key, color] of Object.entries(SECTION_TILE_COLORS)) {
      expect(contrast(SECTION_ON_COLOR, color!), key).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('la tinta es #0b0d0e y todas las secciones coloreadas tienen su par en la paleta viva', () => {
    expect(SECTION_ON_COLOR).toBe('#0b0d0e');
    expect(Object.fromEntries(Object.entries(SECTIONS).map(([k, s]) => [k, s.color]))).toMatchObject({
      copas: '#46efd4',
      comida: '#fd622d',
      entradas: '#4d94fb',
      servicios: '#ff77a2',
      habitaciones: '#bbb8fe',
      propinas: '#feee82',
      saldo: '#9aa4ad',
      otros: '#7c8893',
    });
  });
});
