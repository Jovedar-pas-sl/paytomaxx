import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * El mapa del dinero en cuatro preguntas (panel-money-q.css, Grafito 3 · B).
 * Las pruebas del panel no tienen DOM ni maquetación: aquí se lee el CSS y se
 * comprueban las reglas que importan: dos columnas en el escritorio y una en el
 * móvil (360 px), la raya de color de cada tarjeta, la cifra grande de 40 px en
 * Manrope 700, y que no queda ni el anillo ni las barras dobles de antes.
 */

const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\r\n/g, '\n');
const Q = strip(readFileSync(new URL('../styles/panel-money-q.css', import.meta.url), 'utf8'));
const OLD = strip(readFileSync(new URL('../styles/panel-money.css', import.meta.url), 'utf8'));

interface Rule {
  media: string | null;
  selector: string;
  body: string;
}

function rulesOf(css: string, media: string | null = null): Rule[] {
  const out: Rule[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const prelude = css.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth += 1;
      else if (css[j] === '}') depth -= 1;
      j += 1;
    }
    const body = css.slice(open + 1, j - 1);
    if (prelude.startsWith('@media')) out.push(...rulesOf(body, prelude));
    else for (const selector of prelude.split(',')) out.push({ media, selector: selector.trim().replace(/\s+/g, ' '), body });
    i = j;
  }
  return out;
}

const RULES = rulesOf(Q);
const MOBILE = '@media (max-width: 640px)';

function decl(selector: string, prop: string, media: string | null = null): string | null {
  const r = RULES.find((x) => x.selector === selector && x.media === media);
  const m = r?.body.match(new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`));
  return m ? m[1]!.trim() : null;
}

describe('mapa del dinero en cuatro preguntas', () => {
  it('las cuatro tarjetas, en dos columnas; en el móvil, en una', () => {
    expect(decl('.np-mmq-cards', 'grid-template-columns')).toBe('repeat(2, minmax(0, 1fr))');
    expect(decl('.np-mmq-cards', 'grid-template-columns', MOBILE)).toBe('minmax(0, 1fr)');
  });

  it('cada tarjeta lleva su raya de color de 4 px y una cifra de 40 px en Manrope 700', () => {
    expect(decl('.np-mmq-card', 'border-top')).toBe('4px solid var(--np-mmq-c, var(--np-border-hi))');
    for (const tone of ['ganado', 'caja', 'banco', 'debo']) {
      expect(decl(`.np-mmq-card[data-tone='${tone}']`, '--np-mmq-c')).toBe(`var(--np-mmq-${tone})`);
    }
    expect(decl('.np-mmq-num', 'font-size')).toBe('var(--gf-t-kpi, 2.5rem)');
    expect(decl('.np-mmq-num', 'font-weight')).toBe('700');
    expect(decl('.np-mmq-num', 'font-family')).toBe('var(--np-font-num)');
  });

  it('los dos temas tienen su color de cada tarjeta', () => {
    expect(Q).toMatch(/\[data-theme='light'\]\s*\{[^}]*--np-mmq-debo/);
    expect(Q).toMatch(/\[data-theme='light'\]\s*\{[^}]*--np-mmq-banco/);
  });

  it('el saldo sin gastar es una nota y lo vendido ocupa su fila; sin letra bajo 14 px', () => {
    expect(decl('.np-mmq-saldo', 'font-size')).toBe('var(--gf-t-body, 1rem)');
    expect(decl('.np-mmq-parts', 'font-size')).toBe('var(--gf-t-small, 0.875rem)');
    expect(decl('.np-mmq-sold', 'flex-wrap')).toBe('wrap');
    expect(decl('.np-mmq-sold', 'flex-direction', MOBILE)).toBe('column');
  });

  it('ya no queda el anillo ni las barras apiladas', () => {
    for (const gone of ['np-mm-ring', 'np-mm-hbar', 'np-mm-hleg', 'np-mm-dleg', 'np-mm-srows', 'np-mm-kpis']) {
      expect(OLD, gone).not.toContain(gone);
      expect(Q, gone).not.toContain(gone);
    }
  });
});
