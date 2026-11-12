import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Colores del menú del panel (Grafito 2, styles/panel-nav.css): la fila de
 * secciones, las pastillas de dentro y la barra de abajo del móvil, en los dos
 * temas. Se leen los tokens de verdad (los de @nightpay/ui y los --np-nav-* del
 * panel), se resuelven los var() y se calcula el contraste WCAG 2.x: 4,5:1 el
 * texto y 3:1 las marcas que no son texto (subrayado, filete, icono). Cada par
 * lleva su valor: si alguien cambia un color, la prueba dice cuánto da ahora.
 */

// Sin \r: en Windows git deja los ficheros con CRLF.
const read = (url: URL): string => readFileSync(url, 'utf8').replace(/\r\n/g, '\n');
const UI = read(new URL('../../../../packages/ui/src/styles.css', import.meta.url));
const NAV = read(new URL('../styles/panel-nav.css', import.meta.url));

type Vars = Record<string, string>;

/** Las variables (cualquier valor) del primer bloque que empieza por `selector {`. */
function block(css: string, selector: string): Vars {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no está el bloque ${selector}`);
  const body = css.slice(start + selector.length + 2, css.indexOf('\n}', start)).replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Vars = {};
  for (const m of body.matchAll(/(--np-[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim().toLowerCase();
  return out;
}

const DARK_SEL = ":root,\n[data-theme='dark']";
const LIGHT_SEL = "[data-theme='light']";
// <html data-theme="light"> también es :root: el bloque oscuro vale y el claro lo pisa.
const THEMES: Record<'oscuro' | 'claro', Vars> = {
  oscuro: { ...block(UI, ':root'), ...block(UI, DARK_SEL), ...block(NAV, DARK_SEL) },
  claro: { ...block(UI, ':root'), ...block(UI, DARK_SEL), ...block(UI, LIGHT_SEL), ...block(NAV, DARK_SEL), ...block(NAV, LIGHT_SEL) },
};

/** El color final de un token (#rrggbb o 'transparent'), siguiendo los var(). */
function resolve(vars: Vars, name: string, depth = 0): string {
  const v = vars[name];
  if (v === undefined) throw new Error(`no está ${name}`);
  const ref = v.match(/^var\((--np-[a-z0-9-]+)\)$/);
  if (ref) {
    if (depth > 8) throw new Error(`var() en bucle: ${name}`);
    return resolve(vars, ref[1]!, depth + 1);
  }
  if (v !== 'transparent' && !/^#[0-9a-f]{6}$/.test(v)) throw new Error(`${name}: ${v} no es un color plano`);
  return v;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Contraste de `fg` sobre `bg` en un tema (un fondo transparente deja ver --np-bg). */
function contrast(theme: Vars, fg: string, bg: string): number {
  const back = resolve(theme, bg);
  return ratio(resolve(theme, fg), back === 'transparent' ? resolve(theme, '--np-bg') : back);
}

interface Pair {
  what: string;
  fg: string;
  bg: string;
  /** Lo que da hoy (dos decimales; null = en ese tema no se pinta); el mínimo es 4,5 el texto y 3 lo demás. */
  oscuro: number | null;
  claro: number | null;
  text: boolean;
}

const PAIRS: Pair[] = [
  { what: 'sección cerrada (t1) sobre el fondo', fg: '--np-nav-ink', bg: '--np-bg', oscuro: 17.40, claro: 16.23, text: true },
  { what: 'sección cerrada al pasar el ratón', fg: '--np-nav-ink', bg: '--np-surface', oscuro: 16.23, claro: 17.23, text: true },
  { what: 'sección abierta: su texto sobre su fondo', fg: '--np-nav-on-ink', bg: '--np-nav-on-bg', oscuro: 11.15, claro: 8.66, text: true },
  { what: 'sección abierta al pasar el ratón', fg: '--np-nav-on-ink', bg: '--np-nav-on-bg-hover', oscuro: 12.46, claro: 9.49, text: true },
  { what: 'subrayado de la abierta (3 px) sobre su pastilla lima', fg: '--np-nav-on-bar', bg: '--np-nav-on-bg', oscuro: 11.15, claro: 8.66, text: false },
  { what: 'pastilla cerrada: t1 sobre la superficie', fg: '--np-nav-ink', bg: '--np-nav-pill-bg', oscuro: 16.23, claro: 17.23, text: true },
  { what: 'pastilla cerrada al pasar el ratón', fg: '--np-nav-ink', bg: '--np-nav-pill-bg-hover', oscuro: 14.99, claro: 14.85, text: true },
  { what: 'pastilla abierta: tinta sobre crema (en claro, crema sobre tinta)', fg: '--np-nav-pill-on-ink', bg: '--np-nav-pill-on-bg', oscuro: 11.82, claro: 11.82, text: true },
  { what: 'pastilla abierta al pasar el ratón', fg: '--np-nav-pill-on-ink', bg: '--np-nav-pill-on-bg-hover', oscuro: 12.69, claro: 8.57, text: true },
  { what: 'filete de la pastilla abierta junto al fondo', fg: '--np-nav-pill-on-edge', bg: '--np-bg', oscuro: 16.13, claro: 13.10, text: false },
  { what: 'barra de abajo: etiqueta cerrada (t1)', fg: '--np-nav-ink', bg: '--np-bg', oscuro: 17.40, claro: 16.23, text: true },
  { what: 'barra de abajo: etiqueta abierta', fg: '--np-nav-dock-on-ink', bg: '--np-bg', oscuro: 16.13, claro: 13.10, text: true },
  { what: 'barra de abajo: icono abierto sobre su pastilla', fg: '--np-nav-dock-on-icon', bg: '--np-nav-dock-on-bg', oscuro: 16.13, claro: 11.82, text: false },
  { what: 'barra de abajo: raya de 3 px junto al fondo (solo oscuro)', fg: '--np-nav-dock-on-bar', bg: '--np-bg', oscuro: 16.13, claro: null, text: false },
  { what: 'barra de abajo: filete de la pastilla del icono junto al fondo (solo claro)', fg: '--np-nav-dock-on-edge', bg: '--np-bg', oscuro: null, claro: 13.10, text: false },
];

describe('colores del menú del panel: contraste con los tokens de verdad', () => {
  for (const name of ['oscuro', 'claro'] as const) {
    describe(`tema ${name}`, () => {
      for (const p of PAIRS) {
        const want = p[name];
        if (want === null) {
          it(`${p.what}: no se pinta`, () => expect(resolve(THEMES[name], p.fg)).toBe('transparent'));
          continue;
        }
        it(`${p.what}: ${want.toFixed(2).replace('.', ',')}:1 (≥ ${p.text ? '4,5' : '3'})`, () => {
          const got = contrast(THEMES[name], p.fg, p.bg);
          expect(got).toBeGreaterThanOrEqual(p.text ? 4.5 : 3);
          expect(got).toBeCloseTo(want, 1);
        });
      }
    });
  }

  it('la lima marca la sección abierta de arriba (Hoy, Compañeras…) con tinta oscura, y solo eso: las pastillas y la barra de abajo siguen sin lima', () => {
    for (const name of ['oscuro', 'claro'] as const) {
      const t = THEMES[name];
      expect(resolve(t, '--np-nav-on-bg'), name).toBe(resolve(t, '--np-lime'));
      expect(contrast(t, '--np-nav-on-ink', '--np-nav-on-bg'), name).toBeGreaterThanOrEqual(7);
    }
  });

  it('la lima no marca lo elegido de las pastillas ni de la barra de abajo en ningún tema', () => {
    for (const name of ['oscuro', 'claro'] as const) {
      const t = THEMES[name];
      for (const token of [
        '--np-nav-pill-on-bg', '--np-nav-pill-on-edge',
        '--np-nav-dock-on-ink', '--np-nav-dock-on-icon', '--np-nav-dock-on-bar', '--np-nav-dock-on-bg',
      ]) {
        expect(resolve(t, token), `${name} ${token}`).not.toBe(resolve(t, '--np-lime'));
      }
    }
  });

  it('en oscuro lo elegido de las pastillas y la barra de abajo es crema, no t1', () => {
    const t = THEMES.oscuro;
    for (const fg of ['--np-nav-dock-on-ink', '--np-nav-dock-on-icon', '--np-nav-pill-on-bg']) {
      expect(resolve(t, fg), fg).toBe(resolve(t, '--np-cream'));
    }
    expect(resolve(t, '--np-nav-ink')).toBe(resolve(t, '--np-text'));
  });

  it('en claro lo elegido de las pastillas y la barra de abajo va en tinta con el texto en crema', () => {
    const t = THEMES.claro;
    for (const bg of ['--np-nav-pill-on-bg', '--np-nav-dock-on-bg']) {
      expect(resolve(t, bg), bg).toBe(resolve(t, '--np-ink'));
    }
    for (const fg of ['--np-nav-pill-on-ink', '--np-nav-dock-on-icon']) {
      expect(resolve(t, fg), fg).toBe(resolve(t, '--np-cream'));
    }
  });
});

// ─── Las reglas usan esos tokens (si no, los números de arriba no dirían nada) ──

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

const RULES = rulesOf(NAV.replace(/\/\*[\s\S]*?\*\//g, ''));

function decl(selector: string, prop: string): string | null {
  const r = RULES.find((x) => x.selector === selector && x.media === null);
  const m = r?.body.match(new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`));
  return m ? m[1]!.trim() : null;
}

describe('las reglas del menú usan los tokens probados', () => {
  it.each([
    ['.np-tab', 'color', 'var(--np-nav-ink)'],
    [".np-tab[aria-selected='true']", 'color', 'var(--np-nav-on-ink)'],
    [".np-tab[aria-selected='true']", 'background', 'var(--np-nav-on-bg)'],
    [".np-tab[aria-selected='true']:hover", 'background', 'var(--np-nav-on-bg-hover)'],
    ['.np-tab::after', 'background', 'var(--np-nav-on-bar)'],
    ['.np-tab::after', 'height', '3px'],
    [".np-tabbar[data-size='sm'] .np-tab", 'background', 'var(--np-nav-pill-bg)'],
    [".np-tabbar[data-size='sm'] .np-tab", 'border-radius', 'var(--np-r-pill)'],
    [".np-tabbar[data-size='sm'] .np-tab:hover", 'background', 'var(--np-nav-pill-bg-hover)'],
    [".np-tabbar[data-size='sm'] .np-tab[aria-selected='true']", 'color', 'var(--np-nav-pill-on-ink)'],
    [".np-tabbar[data-size='sm'] .np-tab[aria-selected='true']", 'background', 'var(--np-nav-pill-on-bg)'],
    [".np-tabbar[data-size='sm'] .np-tab[aria-selected='true']:hover", 'background', 'var(--np-nav-pill-on-bg-hover)'],
    [".np-tabbar[data-size='sm'] .np-tab::after", 'content', 'none'],
    ['.np-bottomnav-item', 'color', 'var(--np-nav-ink)'],
    [".np-bottomnav-item[aria-current='page']", 'color', 'var(--np-nav-dock-on-ink)'],
    [".np-bottomnav-item[aria-current='page'] .np-bottomnav-icon", 'color', 'var(--np-nav-dock-on-icon)'],
    [".np-bottomnav-item[aria-current='page'] .np-bottomnav-icon::after", 'background', 'var(--np-nav-dock-on-bg)'],
    [".np-bottomnav-item[aria-current='page'] .np-bottomnav-icon::after", 'box-shadow', 'inset 0 0 0 1px var(--np-nav-dock-on-edge)'],
    ['.np-bottomnav-item::before', 'background', 'var(--np-nav-dock-on-bar)'],
    ['.np-bottomnav-item::before', 'height', '3px'],
  ])('%s { %s: %s }', (selector, prop, value) => {
    expect(decl(selector, prop)).toBe(value);
  });

  it('el filete de las pastillas sale de sus tokens', () => {
    expect(decl(".np-tabbar[data-size='sm'] .np-tab", 'box-shadow')).toBe('inset 0 0 0 1px var(--np-nav-pill-edge)');
    expect(decl(".np-tabbar[data-size='sm'] .np-tab[aria-selected='true']", 'box-shadow')).toBe(
      'inset 0 0 0 1px var(--np-nav-pill-on-edge)',
    );
  });
});
