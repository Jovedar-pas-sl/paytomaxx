import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * «Otras plataformas» (Ajustes) y la consola «Socios» (panel-partners.css).
 * Sin DOM ni maquetación: se lee el CSS. Hasta 640 px (móvil y datáfono),
 * todo a lo ancho y los botones de 44 px; desde ahí (tablet y PC), las
 * conexiones en rejilla y los botones en fila. La clave, en monoespaciada y
 * partida donde haga falta (48 cifras no caben en 360 px).
 */

const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\r\n/g, '\n');
const CSS = strip(readFileSync(new URL('../styles/panel-partners.css', import.meta.url), 'utf8'));

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

function decl(selector: string, prop: string, media: string | null = null): string | null {
  const r = RULES.find((x) => x.selector === selector && x.media === media && new RegExp(`(?:^|;|\\s)${prop}\\s*:`).test(x.body));
  const m = r?.body.match(new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`));
  return m ? m[1]!.trim() : null;
}

describe('Otras plataformas y Socios: medidas', () => {
  it('tablet y PC: las conexiones en rejilla; el móvil, una columna', () => {
    expect(decl('.np-ptn-list', 'grid-template-columns')).toBe('repeat(auto-fill, minmax(min(100%, 22rem), 1fr))');
    expect(decl('.np-ptn-list', 'grid-template-columns', MOBILE)).toBe('minmax(0, 1fr)');
  });

  it('hasta 640 px: los botones, uno bajo otro, a lo ancho y de 44 px', () => {
    expect(decl('.np-ptn-actions', 'flex-direction', MOBILE)).toBe('column');
    expect(decl('.np-ptn-actions .np-btn', 'width', MOBILE)).toBe('100%');
    expect(decl('.np-ptn-actions .np-btn', 'min-height', MOBILE)).toBe('2.75rem');
    expect(decl('.np-ptn-form .np-btn', 'min-height', MOBILE)).toBe('2.75rem');
    expect(decl('.np-ptn-form .np-btn', 'width', MOBILE)).toBe('100%');
  });

  it('desde 641 px, los botones en fila y sin estirar', () => {
    expect(decl('.np-ptn-actions', 'display')).toBe('flex');
    expect(decl('.np-ptn-actions', 'flex-wrap')).toBe('wrap');
  });

  it('la clave: monoespaciada, a 16 px y partida en cualquier sitio', () => {
    expect(decl('.np-ptn-key', 'font-family')).toBe('var(--np-font-mono, ui-monospace, monospace)');
    expect(decl('.np-ptn-key', 'font-size')).toBe('1rem');
    expect(decl('.np-ptn-key', 'word-break')).toBe('break-all');
    expect(decl('.np-ptn-key', 'user-select')).toBe('all');
  });

  it('sin lo que el datáfono no entiende: ni :has, ni color-mix, ni oklch', () => {
    expect(CSS).not.toMatch(/:has\(|color-mix\(|oklch\(/);
  });

  it('los colores, con las variables de la casa', () => {
    expect(CSS).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});

describe('«Movimientos» de una conexión (PR 3 B): medidas', () => {
  const NEW = RULES.filter((r) => /np-ptn-mv/.test(r.selector));

  it('hay reglas que mirar', () => {
    expect(NEW.length).toBeGreaterThan(5);
  });

  it('hasta 640 px: los botones, uno bajo otro, a lo ancho y de 44 px', () => {
    expect(decl('.np-ptn-mv .np-btn', 'width', MOBILE)).toBe('100%');
    expect(decl('.np-ptn-mv .np-btn', 'min-height', MOBILE)).toBe('2.75rem');
    expect(decl('.np-ptn-mv-night', 'flex-direction', MOBILE)).toBe('column');
    expect(decl('.np-ptn-mv-night', 'align-items', MOBILE)).toBe('stretch');
  });

  it('las cargas: en fila desde 641 px; en el móvil, tarjetas', () => {
    expect(decl('.np-ptn-mv-load', 'display')).toBe('grid');
    expect(decl('.np-ptn-mv-load', 'grid-template-columns')).toContain('minmax(0, 1fr)');
    expect(decl('.np-ptn-mv-load', 'display', MOBILE)).toBe('block');
    expect(decl('.np-ptn-mv-load', 'border', MOBILE)).toBe('1px solid var(--np-border)');
    expect(decl('.np-ptn-mv-load', 'border-radius', MOBILE)).toBe('var(--np-r-md)');
  });

  it('nada se sale a 360 px: lo largo se parte y nada tiene un ancho mínimo', () => {
    expect(decl('.np-ptn-mv-load', 'min-width')).toBe('0');
    expect(decl('.np-ptn-mv-desc', 'overflow-wrap')).toBe('anywhere');
    expect(decl('.np-ptn-mv-device', 'overflow-wrap')).toBe('anywhere');
    for (const r of NEW) expect(r.body, r.selector).not.toMatch(/(?:^|[;\s])(?:min-)?width\s*:\s*\d{3,}px/);
  });

  it('para un Chrome 64: sin inset, sin gap, sin min()/clamp() en las reglas nuevas', () => {
    for (const r of NEW) {
      expect(r.body, r.selector).not.toMatch(/(?:^|[;\s])(?:inset|gap|row-gap|column-gap)\s*:/);
      expect(r.body, r.selector).not.toMatch(/\b(?:min|max|clamp)\(/);
      expect(r.selector).not.toMatch(/:has\(/);
    }
    expect(CSS).not.toMatch(/rgba\(\s*\d+\s+\d+/);
  });
});
