import { readFileSync } from 'node:fs';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatMoney, groupThousands } from '@nightpay/contracts';
import { Importe } from '@nightpay/ui';

// «Piezas I» (idea 53): UNA pieza para escribir dinero. Importe es la cara de
// formatMoney (@nightpay/contracts), que sigue siendo la regla (también del
// API): el «€» detrás con espacio duro, el menos de verdad, el cero apagado y,
// en el panel (`decimals="always"`), el «,00» en gris.

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const PIECES = read('../../../../packages/ui/src/pieces.css');
const IMPORTE = read('../../../../packages/ui/src/components/Importe.tsx');

const NBSP = '\u00a0';
const MINUS = '−';
const html = (el: ReactElement): string => renderToStaticMarkup(el);
/** Lo de dentro de la pieza, con el apagado entre corchetes: «33[,00] €». */
const shown = (el: ReactElement): string =>
  html(el)
    .replace(/^<span[^>]*>|<\/span>$/g, '')
    .replace(/<span class="np-importe-dim">([^<]*)<\/span>/g, '[$1]');

/** El cuerpo de la primera regla con ese selector exacto. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no está ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

describe('Importe: la tabla del encargo', () => {
  it('sin céntimos: «33 €» para el personal; en el panel, el «,00» apagado', () => {
    expect(shown(<Importe cents={3300} />)).toBe(`33${NBSP}€`);
    expect(shown(<Importe cents={3300} decimals="always" />)).toBe(`33[,00]${NBSP}€`);
  });

  it('con céntimos de verdad: enteros, en su color y con el punto de los miles', () => {
    expect(shown(<Importe cents={123450} />)).toBe(`1.234,50${NBSP}€`);
    expect(shown(<Importe cents={123450} decimals="always" />)).toBe(`1.234,50${NBSP}€`);
  });

  it('cero: el entero apagado (y su «,00» en el panel); el «€», en su color', () => {
    expect(shown(<Importe cents={0} />)).toBe(`[0]${NBSP}€`);
    expect(shown(<Importe cents={0} decimals="always" />)).toBe(`[0,00]${NBSP}€`);
  });

  it('negativos con el menos de verdad (U+2212), nunca con guion', () => {
    expect(shown(<Importe cents={-1200} />)).toBe(`${MINUS}12${NBSP}€`);
    expect(shown(<Importe cents={-1200} decimals="always" />)).toBe(`${MINUS}12[,00]${NBSP}€`);
    expect(html(<Importe cents={-1200} />)).not.toContain('-12');
  });

  it('`signed`: el «+» delante de lo que suma; el cero, sin signo', () => {
    expect(shown(<Importe cents={120} signed />)).toBe(`+1,20${NBSP}€`);
    expect(shown(<Importe cents={-120} signed />)).toBe(`${MINUS}1,20${NBSP}€`);
    expect(shown(<Importe cents={0} signed />)).toBe(`[0]${NBSP}€`);
  });

  it('otra moneda: su código detrás', () => {
    expect(shown(<Importe cents={1250} currency="USD" />)).toBe(`12,50${NBSP}USD`);
  });
});

describe('Importe: tamaños y estilo', () => {
  it('sin `size` hereda tamaño y peso de su sitio; con él, lo marca', () => {
    expect(html(<Importe cents={3300} />)).toMatch(/^<span class="np-importe">/);
    expect(html(<Importe cents={3300} size="hero" />)).toContain('data-size="hero"');
    expect(html(<Importe cents={3300} size="row" />)).toContain('data-size="row"');
    expect(html(<Importe cents={3300} size="table" />)).toContain('data-size="table"');
  });

  it('acepta className y style de quien lo usa (color, ajuste al ancho)', () => {
    const out = html(<Importe cents={3300} className="np-num" style={{ color: 'var(--np-danger)' }} />);
    expect(out).toContain('class="np-importe np-num"');
    expect(out).toContain('style="color:var(--np-danger)"');
  });

  it('Manrope y en una línea; lo apagado, en --np-text-dim', () => {
    const base = rule(PIECES, '.np-importe');
    expect(base).toContain('font-family: var(--np-font-num)');
    expect(base).toContain('white-space: nowrap');
    expect(base).not.toMatch(/font-size|font-weight/);
    expect(PIECES).toMatch(/\.np-importe-dim,\s*\.np-roll \[data-dim\] \{\s*color: var\(--np-text-dim\);/);
  });

  it('héroe: 40/700 proporcionales (sin tnum) y, donde hay clamp(), el tamaño que crece', () => {
    const hero = rule(PIECES, ".np-importe[data-size='hero']");
    expect(hero).toContain('font-size: var(--np-fs-40)');
    expect(hero).toContain('font-weight: 700');
    expect(hero).toContain('font-variant-numeric: proportional-nums');
    expect(hero).not.toContain("'tnum'");
    const at = PIECES.indexOf('@supports (font-size: clamp(1rem, 1vw, 2rem))');
    expect(at).toBeGreaterThan(-1);
    expect(rule(PIECES.slice(at), ".np-importe[data-size='hero']")).toContain('font-size: var(--np-t-amount)');
  });

  it('fila 18/600 y tabla 14/600 a la derecha, las dos tabulares', () => {
    const row = rule(PIECES, ".np-importe[data-size='row']");
    expect(row).toContain('font-size: var(--np-fs-18)');
    expect(row).toContain('font-weight: 600');
    const table = rule(PIECES, ".np-importe[data-size='table']");
    expect(table).toContain('font-size: var(--np-fs-14)');
    expect(table).toContain('font-weight: 600');
    expect(table).toContain('text-align: right');
    expect(PIECES).toMatch(/\.np-importe\[data-size='row'\],\s*\.np-importe\[data-size='table'\] \{[^}]*font-variant-numeric: tabular-nums;/);
  });

  it('parte el texto de formatMoney por su última coma: ni formatToParts ni un Intl propio', () => {
    expect(IMPORTE).toContain('bare: true');
    expect(IMPORTE).toContain("lastIndexOf(',')");
    expect(IMPORTE).not.toMatch(/formatToParts|Intl\./);
  });

  it('`rolling`: la misma cifra, rodando (RollingNumber), con el «,00» apagado y el «€» fuera', () => {
    const out = html(<Importe cents={127500} size="hero" decimals="always" rolling />);
    expect(out).toContain('np-roll');
    expect(out).toContain('data-size="hero"');
    expect(out).toContain(`<span class="np-sr-only">1.275,00${NBSP}€</span>`);
    // «,», «0» y «0»: tres celdas apagadas.
    expect(out.match(/data-dim="true"/g)).toHaveLength(3);
  });
});

describe('formatMoney: el punto de los miles también en un datáfono viejo', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('groupThousands pone los puntos a 4 cifras o más seguidas; lo ya agrupado no cambia', () => {
    expect(groupThousands('1234,50')).toBe('1.234,50');
    expect(groupThousands(`1234${NBSP}€`)).toBe(`1.234${NBSP}€`);
    expect(groupThousands('1234567,00')).toBe('1.234.567,00');
    expect(groupThousands('-12345,60')).toBe('-12.345,60');
    expect(groupThousands('999,50')).toBe('999,50');
    expect(groupThousands('1.234,50')).toBe('1.234,50');
    expect(groupThousands('12.345,67')).toBe('12.345,67');
  });

  it('en Node (y en un navegador de hoy) no cambia nada', () => {
    expect(formatMoney(123450)).toBe(`1.234,50${NBSP}€`);
    expect(formatMoney(110_900, { compact: true })).toBe(`1.109${NBSP}€`);
    expect(formatMoney(-300)).toBe(`${MINUS}3,00${NBSP}€`);
    expect(formatMoney(123456, { bare: true })).toBe('1.234,56');
    // En inglés, sus comas de siempre: el arreglo es solo de es-ES.
    expect(formatMoney(123450, { locale: 'en-GB', currency: 'GBP' })).toBe('£1,234.50');
  });

  it('Chrome < 106 lee useGrouping «always» como true (agrupar como siempre) y escribía «1234 €»: ya no', async () => {
    const Real = Intl.NumberFormat;
    vi.spyOn(Intl, 'NumberFormat').mockImplementation(function (locale?: string | string[], options?: Intl.NumberFormatOptions) {
      return new Real(locale, { ...options, useGrouping: 'auto' as unknown as boolean });
    } as never);
    vi.resetModules();
    const old = await import('../../../../packages/contracts/src/money');
    // Sin el arreglo, este «navegador» escribe «1234,50 €».
    expect(new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(1234.5)).toBe(`1234,50${NBSP}€`);
    expect(old.formatMoney(123450)).toBe(`1.234,50${NBSP}€`);
    expect(old.formatMoney(110_900, { compact: true })).toBe(`1.109${NBSP}€`);
    expect(old.formatMoney(-123450)).toBe(`${MINUS}1.234,50${NBSP}€`);
    expect(old.formatMoney(123456, { bare: true })).toBe('1.234,56');
    expect(old.formatMoney(1_234_567)).toBe(`12.345,67${NBSP}€`);
  });
});

describe('formatMoney `short`: solo para gráficos', () => {
  const short = (cents: number) => formatMoney(cents, { short: true }).split(NBSP).join(' ');

  it('por debajo de 999,5 €, euros enteros al más cercano', () => {
    expect(short(62_000)).toBe('620 €');
    expect(short(62_050)).toBe('621 €');
    expect(short(99_949)).toBe('999 €');
    expect(short(0)).toBe('0 €');
  });

  it('hasta 9.950 €, miles con un decimal y sin «,0»', () => {
    expect(short(99_960)).toBe('1 mil €');
    expect(short(314_900)).toBe('3,1 mil €');
    expect(short(160_000)).toBe('1,6 mil €');
    expect(short(994_999)).toBe('9,9 mil €');
  });

  it('desde 9.950 €, miles enteros (la mitad, hacia arriba)', () => {
    expect(short(995_000)).toBe('10 mil €');
    expect(short(1_200_000)).toBe('12 mil €');
    expect(short(1_250_000)).toBe('13 mil €');
    expect(short(99_949_900)).toBe('999 mil €');
  });

  it('desde 999.500 €, millones igual', () => {
    expect(short(99_950_000)).toBe('1 M €');
    expect(short(120_000_000)).toBe('1,2 M €');
    expect(short(1_200_000_000)).toBe('12 M €');
  });

  it('negativos con el menos de verdad y sin partirse (espacios duros)', () => {
    expect(short(-62_000)).toBe(`${MINUS}620 €`);
    expect(formatMoney(314_900, { short: true })).toBe(`3,1${NBSP}mil${NBSP}€`);
  });
});
