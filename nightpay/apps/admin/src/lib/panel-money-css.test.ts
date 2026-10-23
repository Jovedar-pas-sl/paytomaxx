import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * El mapa del dinero en el escritorio (panel-money.css). Las pruebas del panel
 * no tienen DOM ni maquetación: aquí se lee el CSS y se comprueban las reglas
 * que evitan los dos fallos que se vieron en la demo (1440 px):
 *  - la pista «Toca las ventas…» ocupaba sola la columna izquierda y «Dónde
 *    está» bajaba a otra fila (media pantalla vacía);
 *  - «Reservados VIP» salía cortado («Reservados …») en «Por sección».
 */

const CSS = readFileSync(new URL('../styles/panel-money.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

interface Rule {
  media: string | null;
  selector: string;
  body: string;
}

/** Las reglas del CSS (una por selector), con la @media que las envuelve. */
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

const RULES = rulesOf(CSS);
const WIDE = '@media (min-width: 900px)';

function rule(selector: string, media: string | null = null): Rule | undefined {
  return RULES.find((r) => r.selector === selector && r.media === media);
}

function decl(r: Rule | undefined, prop: string): string | null {
  const m = r?.body.match(new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`));
  return m ? m[1]!.trim() : null;
}

describe('mapa del dinero en el escritorio (dos columnas desde 900 px)', () => {
  it('todo lo que no es una de las dos columnas (cifras, la pista, notas) ocupa la fila entera', () => {
    const r = rule(".np-mm-body[data-layout='wide'] > :not(.np-mm-col)", WIDE);
    expect(r, 'falta la regla de fila entera').toBeDefined();
    expect(decl(r, 'grid-column')).toBe('1 / -1');
  });

  it('el nombre de una sección nunca se corta con «…»: si no cabe, pasa a dos líneas', () => {
    const r = rule('.np-mm-sr > span:first-child');
    expect(r).toBeDefined();
    expect(decl(r, 'white-space')).not.toBe('nowrap');
    expect(decl(r, 'text-overflow')).toBeNull();
    expect(decl(r, 'overflow')).toBeNull();
    expect(decl(r, 'overflow-wrap')).toBe('anywhere');
    expect(decl(r, 'min-width')).toBe('0');
  });

  it('en el escritorio la columna del nombre es más ancha («Reservados VIP» en una línea)', () => {
    const rem = (cols: string | null) => Number(cols?.match(/^([\d.]+)rem/)?.[1] ?? 0);
    const plain = rule(".np-mm-body[data-layout='wide'] .np-mm-sr", WIDE);
    const open = rule(".np-mm-body[data-layout='wide'] .np-mm-sr[data-open]", WIDE);
    expect(rem(decl(plain, 'grid-template-columns'))).toBeGreaterThanOrEqual(9);
    expect(rem(decl(open, 'grid-template-columns'))).toBeGreaterThanOrEqual(9);
    // Las filas que se abren conservan su cuarta columna (la flecha).
    expect(decl(open, 'grid-template-columns')?.split(/\s+(?![^(]*\))/)).toHaveLength(4);
  });
});
