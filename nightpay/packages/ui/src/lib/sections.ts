/**
 * Colores de las secciones (de qué es cada cobro), los de las maquetas de
 * OxioCard. Los mismos que las variables --np-sec-* de styles.css (un test
 * comprueba que coinciden). Familia pastel con tinta encima; la lima es la
 * marca y nunca es una sección. El saldo / la recarga va en gris y a trazos.
 */

export type SectionKey =
  | 'copas'
  | 'habitaciones'
  | 'comida'
  | 'servicios'
  | 'entradas'
  | 'propinas'
  | 'saldo'
  | 'otros';

/** Categoría de un cobro (revenueCategory / category del servicio de la carta). */
export type SectionCode = 'CHICA_SERVICE' | 'VENUE_BAR' | 'VENUE_ROOM' | 'VENUE_FOOD' | 'VENUE_ENTRY' | 'EXTRA';

export interface Section {
  key: SectionKey;
  /** Nombre corto para el chip («Copas», «Servicios»…). */
  label: string;
  /** Color de relleno (hex), para estilos en línea, SVG o lienzos. */
  color: string;
  /** La misma, como variable CSS (sigue a styles.css). */
  cssVar: string;
  /** Sin relleno y con borde a trazos (el saldo / la recarga). */
  dashed: boolean;
}

const SECTION_LIST: readonly Section[] = [
  { key: 'copas', label: 'Copas', color: '#3fe0c0', cssVar: 'var(--np-sec-copas)', dashed: false },
  { key: 'habitaciones', label: 'Habitaciones', color: '#c4b0f5', cssVar: 'var(--np-sec-habitaciones)', dashed: false },
  { key: 'comida', label: 'Comida', color: '#f2b49b', cssVar: 'var(--np-sec-comida)', dashed: false },
  { key: 'servicios', label: 'Servicios', color: '#d24fd8', cssVar: 'var(--np-sec-servicios)', dashed: false },
  { key: 'entradas', label: 'Entradas', color: '#8fc3f2', cssVar: 'var(--np-sec-entradas)', dashed: false },
  { key: 'propinas', label: 'Propinas', color: '#3fa9f5', cssVar: 'var(--np-sec-propinas)', dashed: false },
  { key: 'saldo', label: 'Saldo', color: '#9aa4ad', cssVar: 'var(--np-sec-saldo)', dashed: true },
  { key: 'otros', label: 'Otros', color: '#7c8893', cssVar: 'var(--np-sec-otros)', dashed: false },
];

export const SECTIONS: Readonly<Record<SectionKey, Section>> = Object.freeze(
  Object.fromEntries(SECTION_LIST.map((s) => [s.key, s])) as Record<SectionKey, Section>,
);

/** De la categoría del cobro a su sección. EXTRA (cobros antiguos sin sección) va en gris, como «Otros». */
export const SECTION_BY_CODE: Readonly<Record<SectionCode, SectionKey>> = Object.freeze({
  CHICA_SERVICE: 'servicios',
  VENUE_BAR: 'copas',
  VENUE_ROOM: 'habitaciones',
  VENUE_FOOD: 'comida',
  VENUE_ENTRY: 'entradas',
  EXTRA: 'otros',
});

/** Tinta sobre cualquier color de sección (≥ 5:1 en todas). */
export const SECTION_ON_COLOR = '#0f1112';

/** Gris neutro para lo que no tiene sección conocida (nunca lima). */
export const SECTION_FALLBACK_COLOR = '#7c8893';
const SECTION_FALLBACK_VAR = 'var(--np-sec-otros)';

/** La sección de una categoría o de una clave («VENUE_BAR» o «copas»); null si no se conoce. */
export function sectionOf(code: string | null | undefined): Section | null {
  if (!code) return null;
  const key = (SECTION_BY_CODE as Record<string, SectionKey | undefined>)[code] ?? code;
  return (SECTIONS as Record<string, Section | undefined>)[key] ?? null;
}

/** Color (hex) de la sección de una categoría; gris neutro si no se conoce. */
export function sectionColor(code: string | null | undefined): string {
  return sectionOf(code)?.color ?? SECTION_FALLBACK_COLOR;
}

/** Igual que sectionColor, como variable CSS (var(--np-sec-…)). */
export function sectionVar(code: string | null | undefined): string {
  return sectionOf(code)?.cssVar ?? SECTION_FALLBACK_VAR;
}

/**
 * El texto del chip de las secciones de un cobro («Copas + Cocina», como
 * mucho dos): con el nombre que les puso el local (`labelOf`, el de Ajustes →
 * Secciones) o, sin él, el de fábrica.
 */
export function sectionsChipText(codes: readonly string[], labelOf?: (code: string) => string): string {
  return codes
    .slice(0, 2)
    .map((c) => labelOf?.(c) ?? sectionOf(c)?.label ?? c)
    .join(' + ');
}
