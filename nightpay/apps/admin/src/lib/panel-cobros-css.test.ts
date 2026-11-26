import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Cobros (entrega 9, parte A): la tabla de seis columnas con filas de 48 px, la
 * tarjeta de 72 en el móvil, el detalle al lado desde 1280 y las vistas. Las
 * pruebas del panel no tienen DOM ni maquetación: aquí se lee el CSS.
 */

const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\r\n/g, '\n');
const read = (name: string): string => strip(readFileSync(new URL(`../styles/${name}`, import.meta.url), 'utf8'));
const CSS = read('panel-cobros.css');

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
const DOCK = '@media (min-width: 1280px)';
const TOUCH = '@media (max-width: 640px), (pointer: coarse)';

function body(selector: string, media: string | null = null): string {
  const r = RULES.find((x) => x.selector === selector && x.media === media);
  if (!r) throw new Error(`no está ${selector}${media ? ` en ${media}` : ''}`);
  return r.body;
}
function decl(selector: string, prop: string, media: string | null = null): string | null {
  const m = body(selector, media).match(new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`));
  return m ? m[1]!.trim() : null;
}

describe('la tabla de Cobros', () => {
  it('filas de 48 px', () => {
    expect(decl('.np-table.np-cobros-table tbody td', 'height', WIDE)).toBe('3rem');
  });

  it('ya no hay ancho mínimo de 75rem ni columnas en rejilla: la tabla cabe sin desplazarse', () => {
    for (const file of ['panel-cobros.css', 'panel-grafito.css', 'panel-tables.css', 'panel-vivo.css']) {
      const css = read(file);
      expect(css, file).not.toContain('min-width: 75rem');
      // La tabla misma, sin ancho mínimo (sus celdas sí pueden encoger: min-width: 0).
      expect(css, file).not.toMatch(/\.np-cobros-table\s*\{[^}]*min-width/);
      expect(css, file).not.toContain("col[data-col=");
      expect(css, file).not.toContain('np-cobros-table--acciones');
      expect(css, file).not.toContain('np-cobros-filters');
    }
    expect(decl('.np-table.np-cobros-table', 'table-layout', WIDE)).toBe('fixed');
  });

  it('de 641 a 899 no cabe «Cómo pagó»; desde 900, las seis', () => {
    expect(decl(".np-cobros-table [data-card='como']", 'display', '@media (min-width: 641px) and (max-width: 899px)')).toBe('none');
  });

  it('hasta 640, cada cobro es una tarjeta de 72 px en dos líneas', () => {
    expect(decl('.np-table.np-cobros-table tbody tr', 'min-height', MOBILE)).toBe('4.5rem');
    // Arriba, qué e importe; abajo, hora, quién y estado. «Cómo pagó» y las columnas de más, no.
    expect(decl(".np-table.np-cobros-table tbody td[data-card='que']", 'order', MOBILE)).toBe('1');
    expect(decl(".np-table.np-cobros-table tbody td[data-card='importe']", 'order', MOBILE)).toBe('1');
    for (const cell of ['hora', 'quien', 'estado']) expect(decl(`.np-table.np-cobros-table tbody td[data-card='${cell}']`, 'order', MOBILE), cell).toBe('3');
    for (const cell of ['como', 'codigo', 'banco']) expect(decl(`.np-table.np-cobros-table tbody td[data-card='${cell}']`, 'display', MOBILE), cell).toBe('none');
  });

  it('la franja del color de la sección (panel-vivo.css): desde 641 en la primera celda; hasta 640, el borde de la tarjeta', () => {
    const vivo = rulesOf(read('panel-vivo.css'));
    const of = (selector: string, media: string) => vivo.find((r) => r.selector === selector && r.media === media)?.body ?? '';
    expect(of('.np-cobros-table tbody tr > td:first-child', WIDE)).toContain('box-shadow: inset 4px 0 0 var(--np-row, transparent);');
    expect(of('.np-cobros-table tbody tr', MOBILE)).toContain('border-left: 4px solid var(--np-row, var(--np-border));');
    // Ya no cambia a 1100 px: entre 641 y 1100 hay tabla, no tarjetas.
    expect(read('panel-vivo.css')).not.toContain('1100px');
  });

  it('la fila que se abre se nota al pasar, con el teclado y cuando es la abierta', () => {
    expect(decl('.np-cobros-table tbody tr[tabindex]', 'cursor')).toBe('pointer');
    expect(body('.np-cobros-table tbody tr[tabindex]:focus-visible')).toContain('outline');
    expect(decl(".np-cobros-table tbody tr[aria-current='true']", 'background')).toBe('var(--np-surface-2)');
  });
});

describe('el detalle al lado', () => {
  it('desde 1280, lista y detalle en dos columnas: la del detalle, de 27.5rem', () => {
    expect(decl('.np-cobros-split[data-open]', 'grid-template-columns', DOCK)).toBe('minmax(0, 1fr) 27.5rem');
    expect(RULES.some((r) => r.selector.startsWith('.np-cobros-split') && r.media !== DOCK && /grid-template-columns/.test(r.body))).toBe(false);
  });

  it('se queda pegado arriba, a todo el alto y con su propio desplazamiento: `100vh` antes de `100dvh`', () => {
    const dock = body('.np-cobro-dock');
    expect(decl('.np-cobro-dock', 'position')).toBe('sticky');
    expect(decl('.np-cobro-dock', 'top')).toBe('0');
    expect(decl('.np-cobro-dock', 'overflow-y')).toBe('auto');
    expect(dock).toMatch(/height:\s*100vh;\s*height:\s*100dvh;/);
  });

  it('con el detalle abierto entre 1280 y 1439, las columnas se aprietan y «Qué» se lleva el resto', () => {
    const NARROW = '@media (min-width: 1280px) and (max-width: 1439px)';
    const widths = { hora: '5rem', quien: '7rem', como: '8rem', estado: '9rem', importe: '7rem' };
    for (const [cell, w] of Object.entries(widths)) {
      expect(decl(`.np-cobros-split[data-open] .np-cobros-table th[data-card='${cell}']`, 'width', NARROW), cell).toBe(w);
    }
    expect(RULES.some((r) => r.media === NARROW && r.selector.includes("th[data-card='que']"))).toBe(false);
  });

  it('el pie con los botones del cobro se queda abajo, sobre el fondo del detalle', () => {
    expect(decl('.np-cobro-pie', 'position')).toBe('sticky');
    expect(decl('.np-cobro-pie', 'bottom')).toBe('0');
    expect(decl('.np-cobro-pie', 'background')).toBe('var(--np-surface)');
  });
});

describe('vistas y fichas de los filtros', () => {
  it('las vistas: pastillas de 36 px (44 con el dedo) en una línea que se desplaza', () => {
    expect(decl('.np-cobros-views', 'overflow-x')).toBe('auto');
    expect(decl('.np-cobros-view', 'min-height')).toBe('2.25rem');
    expect(decl('.np-cobros-view', 'white-space')).toBe('nowrap');
    expect(decl('.np-cobros-view', 'flex')).toBe('none');
    expect(decl('.np-cobros-view', 'min-height', TOUCH)).toBe('2.75rem');
  });

  it('la vista elegida: fondo --np-surface-3, sin lima ni visto', () => {
    const on = body(".np-cobros-view[aria-pressed='true']");
    expect(decl(".np-cobros-view[aria-pressed='true']", 'background')).toBe('var(--np-surface-3)');
    expect(on).not.toMatch(/accent|lime/);
    expect(CSS).not.toMatch(/\.np-cobros-view[^{]*::(before|after)/);
  });

  it('las fichas y los botones pequeños de la barra, a 44 con el dedo (también en tablet)', () => {
    expect(decl('.np-cobros-chip', 'min-height', TOUCH)).toBe('2.75rem');
    expect(decl(".np-cobros-bar .np-btn[data-size='sm']", 'min-height', TOUCH)).toBe('2.75rem');
  });

  it('hasta 640, el buscador y «Filtros (N)»; lo demás, dentro', () => {
    expect(decl('.np-cobros-bar [data-wide-only]', 'display', MOBILE)).toBe('none');
    expect(decl('.np-cobros-bar [data-mobile-only]', 'display', WIDE)).toBe('none');
  });

  it('solo se anima lo de siempre y nada de lo que un navegador viejo no entienda sin respaldo', () => {
    expect(CSS).not.toMatch(/:has\(|color-mix|oklch|backdrop-filter/);
  });
});
