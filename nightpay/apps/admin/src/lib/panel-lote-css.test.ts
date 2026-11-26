import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * «A quién hay que pagar» (panel-lote.css, entrega 11 B). Sin DOM ni
 * maquetación: se lee el CSS. La fila de 56 px (64 en dos líneas hasta 640),
 * la barra fija de 56 px sobre la de secciones en el móvil (con una línea sin
 * env() para el navegador que no lo entiende) y la de 48 pegada abajo en la
 * columna desde 641, la lista de 56rem como mucho y nada que un Chrome 64 no
 * entienda.
 */

const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\r\n/g, '\n');
const CSS = strip(readFileSync(new URL('../styles/panel-lote.css', import.meta.url), 'utf8'));
const LAYOUT = readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8');

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

const RULES = rulesOf(CSS);
const MOBILE = '@media (max-width: 640px)';
const WIDE = '@media (min-width: 641px)';

function decls(selector: string, prop: string, media: string | null = null): string[] {
  const r = RULES.find((x) => x.selector === selector && x.media === media);
  if (!r) return [];
  return [...r.body.matchAll(new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`, 'g'))].map((m) => m[1]!.trim());
}
const decl = (selector: string, prop: string, media: string | null = null): string | null => decls(selector, prop, media)[0] ?? null;

describe('pagar a todas: medidas', () => {
  it('el panel lo carga', () => {
    expect(LAYOUT).toContain("import '../styles/panel-lote.css';");
  });

  it('la fila: 56 px en una línea; hasta 640, dos líneas de 64', () => {
    expect(decl('.np-lote-row', 'min-height')).toBe('3.5rem');
    expect(decl('.np-lote-row .np-checkbox-text', 'flex-direction', WIDE)).toBe('row');
    expect(decl('.np-lote-row', 'min-height', MOBILE)).toBe('4rem');
  });

  it('los avisos de la fila a 14 px; el del titular, en el color de aviso', () => {
    expect(decl('.np-lote-note', 'font-size')).toBe('var(--np-fs-14)');
    expect(decl(".np-lote-note[data-tone='warning']", 'color')).toBe('var(--np-warning)');
  });

  it('móvil: barra fija de 56 px sobre la de secciones, con la línea sin env() delante', () => {
    expect(decl('.np-lote-bar', 'position', MOBILE)).toBe('fixed');
    expect(decl('.np-lote-bar', 'min-height', MOBILE)).toBe('3.5rem');
    expect(decls('.np-lote-bar', 'bottom', MOBILE)).toEqual([
      'var(--np-panel-nav-h)',
      'calc(var(--np-panel-nav-h) + env(safe-area-inset-bottom, 0px))',
    ]);
    expect(decl('.np-lote-list', 'margin-bottom', MOBILE)).toBe('3.5rem');
  });

  it('desde 641: barra de 48 px pegada abajo en la columna', () => {
    expect(decl('.np-lote-bar', 'position')).toBe('sticky');
    expect(decl('.np-lote-bar', 'bottom')).toBe('0');
    expect(decl('.np-lote-bar', 'min-height')).toBe('3rem');
  });

  it('en el PC, la lista de 56rem como mucho', () => {
    expect(decl('.np-lote', 'max-width')).toBe('56rem');
  });

  it('nada que un Chrome 64 no entienda', () => {
    expect(CSS).not.toMatch(/\binset\s*:/);
    expect(CSS).not.toMatch(/(?:^|[;{\s])(?:row-|column-)?gap\s*:/);
    expect(CSS).not.toMatch(/\b(?:min|max|clamp)\(/);
    expect(CSS).not.toMatch(/:has\(|color-mix\(|oklch\(/);
    expect(CSS).not.toMatch(/var\([^)]*env\(/);
    expect(CSS).not.toMatch(/rgba?\([^,)]*\s\/\s/);
  });
});
