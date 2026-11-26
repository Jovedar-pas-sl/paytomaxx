import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SECTION_ON_COLOR, SECTIONS } from '@nightpay/ui';
import { APP_BACKGROUND } from '@nightpay/ui/app-manifest';

// «Color y relieve» (25-nov-2026, ideas 1, 2, 3, 11 y 12): suelo más oscuro con
// su escala de superficies, tarjetas con relieve, botones en píldora con
// relieve, colores de sección nuevos y la lima más viva en pantallas P3. Los
// valores están decididos y medidos; aquí se leen de styles.css y se CALCULA
// el contraste WCAG 2.x, para que nadie los baje sin que se note.

const REPO = join(__dirname, '..', '..', '..', '..');
// Sin \r: en Windows git deja los ficheros con CRLF.
const read = (...rel: string[]): string => readFileSync(join(REPO, ...rel), 'utf8').replace(/\r\n/g, '\n');
const STYLES = read('packages', 'ui', 'src', 'styles.css');
const STAFF = read('packages', 'ui', 'src', 'staff.css');
const TOUR = read('packages', 'ui', 'src', 'tour.css');
const COBRAR = read('apps', 'operator', 'src', 'components', 'cobrar', 'cobrar.module.css');
const DESK = read('apps', 'operator', 'src', 'components', 'reception', 'desk', 'desk.module.css');
const PARTY = read('apps', 'operator', 'src', 'components', 'party', 'party.module.css');

/** Sin los comentarios: lo que cuenta es el estilo, no lo que se explica. */
const code = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** El cuerpo del primer bloque que empieza por `selector {` (hasta su llave de cierre en columna 0). */
function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no está el bloque ${selector}`);
  return css.slice(start + selector.length + 2, css.indexOf('\n}', start));
}

/** El cuerpo de una regla que empieza la línea con ese selector exacto. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no está la regla ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

/** Todas las variables de un bloque, con el valor tal cual (en minúsculas). */
function vars(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of code(body).matchAll(/(--np-[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim().replace(/\s+/g, ' ').toLowerCase();
  return out;
}

const ROOT = vars(block(STYLES, ':root'));
const DARK = vars(block(STYLES, ":root,\n[data-theme='dark']"));
const LIGHT = vars(block(STYLES, "[data-theme='light']"));
const SALA = vars(block(STYLES, "html[data-contrast='sala']"));

/** El color final (#rrggbb) de una variable del tema oscuro, siguiendo los var(). */
function hex(name: string, theme: Record<string, string> = { ...ROOT, ...DARK }, depth = 0): string {
  const v = theme[name];
  if (v === undefined || depth > 6) throw new Error(`no está ${name}`);
  const ref = /^var\((--np-[a-z0-9-]+)\)$/.exec(v);
  if (ref) return hex(ref[1]!, theme, depth + 1);
  if (!/^#[0-9a-f]{6}$/.test(v)) throw new Error(`${name}: ${v} no es un color plano`);
  return v;
}

function rgb(h: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance(h: string): number {
  const [r, g, b] = rgb(h).map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contraste WCAG 2.x entre dos colores hex. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Distancia entre dos colores (en RGB): dos fondos con menos de 20 se confunden. */
function distance(a: string, b: string): number {
  const [x, y] = [rgb(a), rgb(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

const SURFACES = ['--np-surface', '--np-surface-2', '--np-surface-3'] as const;

describe('idea 1 · suelo más oscuro y escala de superficies (tema oscuro)', () => {
  it.each([
    ['--np-bg', '#091518'],
    ['--np-sunk', '#111e22'],
    ['--np-surface', '#19272b'],
    ['--np-surface-2', '#223035'],
    ['--np-surface-3', '#2b3b40'],
    ['--np-border', '#314045'],
    ['--np-border-hi', '#7f939a'],
    ['--np-text', '#efe9df'],
    ['--np-text-mute', '#cfcbc2'],
    ['--np-text-label', '#cfcbc2'],
    ['--np-text-dim', '#bab6ad'],
    ['--np-on-accent', '#091518'],
    ['--np-primary-ink', '#091518'],
    ['--np-danger-text', '#ff9a94'],
  ])('%s vale %s', (name, value) => {
    expect(DARK[name]).toBe(value);
  });

  it('los semánticos se quedan y se leen sobre lo elevado (≥ 4,5:1 sobre surface-2)', () => {
    expect(DARK).toMatchObject({ '--np-success': '#58d68d', '--np-danger': '#ff6b6b', '--np-warning': '#f5b342', '--np-purple': '#c9a3ff' });
    for (const name of ['--np-success', '--np-danger', '--np-warning', '--np-purple']) {
      expect(contrast(hex(name), hex('--np-surface-2')), name).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('texto ≥ 7:1 sobre las tarjetas; el secundario ≥ 7:1 aún sobre lo elevado', () => {
    expect(contrast(hex('--np-text'), hex('--np-surface'))).toBeGreaterThanOrEqual(7);
    expect(contrast(hex('--np-text'), hex('--np-surface-3'))).toBeGreaterThanOrEqual(7);
    expect(contrast(hex('--np-text-mute'), hex('--np-surface-2'))).toBeGreaterThanOrEqual(7);
    expect(contrast(hex('--np-text-label'), hex('--np-surface-2'))).toBeGreaterThanOrEqual(7);
  });

  it('las ayudas («dim») ≥ 7:1 sobre las tarjetas y ≥ 6:1 sobre lo elevado', () => {
    expect(contrast(hex('--np-text-dim'), hex('--np-surface'))).toBeGreaterThanOrEqual(7);
    expect(contrast(hex('--np-text-dim'), hex('--np-surface-2'))).toBeGreaterThanOrEqual(6);
  });

  it('el filete de lo que se toca se ve (≥ 3:1) sobre las tres superficies', () => {
    for (const bg of SURFACES) expect(contrast(hex('--np-border-hi'), hex(bg)), bg).toBeGreaterThanOrEqual(3);
  });

  it('la tinta sobre la lima ≥ 7:1 y el rojo de los errores pequeños ≥ 6,5:1 hasta lo elevado', () => {
    expect(contrast(hex('--np-on-accent'), hex('--np-lime'))).toBeGreaterThanOrEqual(7);
    expect(contrast(hex('--np-primary-ink'), hex('--np-primary-bg'))).toBeGreaterThanOrEqual(7);
    expect(contrast(hex('--np-danger-text'), hex('--np-surface'))).toBeGreaterThanOrEqual(7);
    expect(contrast(hex('--np-danger-text'), hex('--np-surface-2'))).toBeGreaterThanOrEqual(6.5);
  });

  it('las zonas hundidas (--np-sunk) quedan entre el suelo y la tarjeta, y el texto se lee', () => {
    const [bg, sunk, surface] = ['--np-bg', '--np-sunk', '--np-surface'].map((n) => luminance(hex(n))) as [number, number, number];
    expect(sunk).toBeGreaterThan(bg);
    expect(sunk).toBeLessThan(surface);
    expect(contrast(hex('--np-text-mute'), hex('--np-sunk'))).toBeGreaterThanOrEqual(7);
    // En claro existe también (el papel de siempre): si no, heredaría el oscuro.
    expect(LIGHT['--np-sunk']).toBeDefined();
  });

  it('la barra de abajo del panel en el móvil también es zona hundida (en claro, el fondo de siempre)', () => {
    const nav = read('apps', 'admin', 'src', 'styles', 'panel-nav.css');
    expect(vars(block(nav, ":root,\n[data-theme='dark']"))['--np-nav-dock-bg']).toBe('var(--np-sunk)');
    expect(vars(block(nav, "[data-theme='light']"))['--np-nav-dock-bg']).toBe('var(--np-bg)');
    expect(code(nav)).toMatch(/\.np-bottomnav \{[^}]*background: var\(--np-nav-dock-bg\);/);
  });

  it('las píldoras de estado: su texto ≥ 4,5:1 y su fondo no se confunde con la tarjeta ni con lo elevado', () => {
    const pairs: Array<[string, string[]]> = [
      ['--np-pill-mute-bg', ['--np-text-mute', '--np-text']],
      ['--np-pill-cyan-bg', ['--np-lime', '--np-text']],
      ['--np-pill-success-bg', ['--np-success']],
      ['--np-pill-danger-bg', ['--np-danger', '--np-danger-text', '--np-text']],
      ['--np-pill-warning-bg', ['--np-warning']],
      ['--np-pill-purple-bg', ['--np-purple']],
    ];
    for (const [bg, inks] of pairs) {
      for (const ink of inks) expect(contrast(hex(ink), hex(bg)), `${ink} sobre ${bg}`).toBeGreaterThanOrEqual(4.5);
      for (const surface of ['--np-surface', '--np-surface-2']) {
        expect(distance(hex(bg), hex(surface)), `${bg} junto a ${surface}`).toBeGreaterThanOrEqual(20);
      }
    }
  });

  it('«¿Cómo paga?»: los dos bloques se leen (texto ≥ 7:1) y no se confunden con las superficies', () => {
    for (const m of ['cash', 'card']) {
      const bg = hex(`--np-${m}-bg`);
      expect(contrast(hex('--np-text'), bg), m).toBeGreaterThanOrEqual(7);
      expect(contrast(hex(`--np-${m}-sub`), bg), m).toBeGreaterThanOrEqual(4.5);
      expect(contrast(hex(`--np-${m}-line`), bg), m).toBeGreaterThanOrEqual(3);
      for (const surface of ['--np-surface', '--np-surface-2']) expect(distance(bg, hex(surface)), `${m} junto a ${surface}`).toBeGreaterThanOrEqual(20);
    }
  });

  it('el botón apagado sigue neutro y se lee (≥ 6,5:1), y el velo de las ventanas es del tono del suelo', () => {
    expect(DARK['--np-disabled-bg']).toBe('var(--np-surface-2)');
    expect(contrast(hex('--np-disabled-ink'), hex('--np-disabled-bg'))).toBeGreaterThanOrEqual(6.5);
    expect(DARK['--np-backdrop']).toBe('rgba(3, 10, 12, 0.74)');
    expect(ROOT['--np-card-oxio']).toBe('#19272b');
  });

  it('los resultados no cambian (PAGADO, NO PAGADO, caducado y la franja de conexión)', () => {
    expect(ROOT).toMatchObject({
      '--np-outcome-ink': '#f4f2ec',
      '--np-outcome-paid': '#0b3d24',
      '--np-outcome-failed': '#7a1c20',
      '--np-outcome-expired': '#5c4300',
      '--np-banner-bg': '#ffb020',
    });
  });

  it('el tema claro conserva su paleta', () => {
    expect(LIGHT).toMatchObject({
      '--np-bg': '#f7f5f0',
      '--np-surface': '#fdfcf9',
      '--np-surface-2': '#eeebe4',
      '--np-surface-3': '#e3dfd6',
      '--np-border': '#dcd8cf',
      '--np-border-hi': '#827a6c',
      '--np-text': '#15191c',
      '--np-text-mute': '#4a545c',
      '--np-text-dim': '#5a636c',
    });
  });

  it('el modo «sala» sigue subiendo el contraste sobre las superficies nuevas', () => {
    const sala = { ...ROOT, ...DARK, ...SALA };
    expect(contrast(hex('--np-text-mute', sala), hex('--np-surface-2'))).toBeGreaterThanOrEqual(10);
    expect(contrast(hex('--np-text-dim', sala), hex('--np-surface-3'))).toBeGreaterThanOrEqual(7);
    expect(contrast(hex('--np-border-hi', sala), hex('--np-bg'))).toBeGreaterThanOrEqual(6);
    for (const name of ['--np-text-mute', '--np-text-dim', '--np-border', '--np-border-hi']) {
      expect(contrast(hex(name, sala), hex('--np-surface')), name).toBeGreaterThan(contrast(hex(name), hex('--np-surface')));
    }
  });

  it('la barra del sistema y el manifiesto van con el suelo nuevo, en las cuatro apps y en las páginas del cliente', () => {
    expect(APP_BACKGROUND).toBe('#091518');
    for (const app of ['operator', 'admin', 'tpv', 'web-client']) {
      const layout = read('apps', app, 'src', 'app', 'layout.tsx');
      expect(layout, app).toContain('#091518');
      expect(layout.toLowerCase(), app).not.toMatch(/#0b0d0e|#0f1112/);
    }
    expect(read('apps', 'operator', 'src', 'lib', 'day-mode.ts')).toContain("NIGHT_CHROME = '#091518'");
  });
});

// La paleta de antes de «Color y relieve». Lo que la repite a mano se queda
// atrás cuando cambian las fichas: fuera de las excepciones, no debe quedar.
const OLD_PALETTE = ['#0b0d0e', '#131618', '#1a1e21', '#23282c', '#262b30', '#6b7680', '#f4f2ec', '#b8c0c6', '#9da6ae', '#11160a', '#ff8a84'];
const OLD_SECTIONS = ['#00e0ae', '#ff8a3d', '#3d9bff', '#e447f0', '#a98bff', '#ffc94d'];

/** Los ficheros de código (no pruebas) de una carpeta, hacia dentro. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'dist' || name === '.turbo') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(css|tsx?|mjs)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

/** Donde un color antiguo SÍ vale: la tinta de las secciones y los resultados (no cambian). Se quitan antes de mirar. */
const KEEPS: RegExp[] = [
  /--np-on-section:\s*#0b0d0e/gi, // tinta sobre el color de sección
  /SECTION_ON_COLOR = '#0b0d0e'/g,
  /tinta #0b0d0e sobre/g, // un comentario de cobrar.module.css sobre esa tinta
  /--np-outcome-(?:ink|paid-ink):\s*#f4f2ec/gi, // los resultados no cambian
  /--paid-ink:#f4f2ec/gi, // …ni en las páginas del cliente
];

/** Los colores de la lista que quedan en cada línea de cada fichero (sin lo permitido). */
function leftovers(files: string[], palette: string[], keeps: RegExp[] = []): string[] {
  const left: string[] = [];
  for (const file of files) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const clean = keeps.reduce((text, re) => text.replace(re, ''), line).toLowerCase();
        const hit = palette.find((c) => clean.includes(c));
        if (hit) left.push(`${file.slice(REPO.length + 1)}:${i + 1} ${hit}`);
      });
  }
  return left;
}

describe('no quedan colores de la paleta anterior escritos a mano', () => {
  const files = ['apps', 'packages'].flatMap((top) =>
    readdirSync(join(REPO, top)).flatMap((pkg) => {
      const src = join(REPO, top, pkg, 'src');
      try {
        return statSync(src).isDirectory() ? sources(src) : [];
      } catch {
        return [];
      }
    }),
  );

  it('se miran los ficheros de las apps y de los paquetes', () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it('ni neutros antiguos (fuera de la tinta de sección y los resultados)', () => {
    expect(leftovers(files, OLD_PALETTE, KEEPS)).toEqual([]);
  });

  it('ni colores de sección antiguos (solo en la lista de «de fábrica antiguos» de contracts)', () => {
    const rest = files.filter((file) => !file.endsWith(join('contracts', 'src', 'sections.ts')));
    expect(leftovers(rest, OLD_SECTIONS)).toEqual([]);
  });
});

describe('idea 2 · tarjetas con relieve', () => {
  it('las sombras: un filo de luz arriba y sombra del tono del suelo (dos niveles)', () => {
    // Los valores del encargo, escritos rgba(r, g, b, a): es el mismo color, y
    // así lo entiende también el Chrome 64 de los datáfonos (ver abajo).
    expect(DARK['--np-hi']).toBe('inset 0 1px 0 rgba(239, 233, 223, 0.08)');
    expect(DARK['--np-shadow-1']).toBe('var(--np-hi), 0 1px 2px rgba(3, 10, 12, 0.5)');
    expect(DARK['--np-shadow-2']).toBe('inset 0 1px 0 rgba(239, 233, 223, 0.08), 0 2px 4px rgba(3, 10, 12, 0.4), 0 12px 24px -12px rgba(3, 10, 12, 0.6)');
    expect(DARK['--np-card-edge']).toBe('rgba(239, 233, 223, 0.07)');
    expect(DARK['--np-card-fill']).toBe('linear-gradient(180deg, var(--np-surface-2), var(--np-surface))');
  });

  it('en claro, equivalentes suaves: sombra de tinta, sin filo de luz crema ni degradado', () => {
    for (const name of ['--np-hi', '--np-shadow-1', '--np-shadow-2']) {
      expect(LIGHT[name], name).toBeDefined();
      expect(LIGHT[name], name).not.toMatch(/239[ ,]+233[ ,]+223/);
      expect(LIGHT[name], name).not.toMatch(/\(3[ ,]+10[ ,]+12\b/);
    }
    expect(LIGHT['--np-shadow-2']).toContain('rgba(31, 44, 54,');
    expect(LIGHT['--np-card-fill']).toBe('none');
    expect(LIGHT['--np-card-edge']).toBe('var(--np-border)');
  });

  it('.np-card: degradado de lo elevado a la superficie (con el color de respaldo), borde translúcido y sombra', () => {
    const card = rule(STYLES, '.np-card');
    expect(card).toContain('background-color: var(--np-surface);');
    expect(card).toContain('background-image: var(--np-card-fill);');
    expect(card).toContain('border: 1px solid var(--np-card-edge);');
    expect(card).toContain('border-radius: var(--np-r-card);');
    expect(card).toContain('box-shadow: var(--np-shadow-1);');
    // El respaldo va ANTES del degradado: un navegador que no lo entienda se queda con el color.
    expect(card.indexOf('background-color')).toBeLessThan(card.indexOf('background-image'));
  });

  it('la tarjeta común (Card) usa esa clase y no pinta fondo ni borde a mano', () => {
    const card = read('packages', 'ui', 'src', 'components', 'Card.tsx');
    expect(card).toContain("'np-card'");
    expect(code(card).replace(/\/\/.*$/gm, '')).not.toMatch(/background:|border:|borderRadius:/);
  });

  it('lo que flota (ventanas y la burbuja de la guía) lleva la sombra grande', () => {
    expect(read('packages', 'ui', 'src', 'components', 'Modal.tsx')).toContain("boxShadow: 'var(--np-shadow-2)'");
    expect(rule(TOUR, '.np-tour-bubble')).toContain('box-shadow: var(--np-shadow-2);');
  });

  it('también los avisos que flotan arriba y la hoja de cerrar la noche (en el escritorio, una ventana)', () => {
    for (const file of ['InvitationToast.tsx', 'NfcEscucha.tsx']) {
      const src = read('apps', 'operator', 'src', 'components', file);
      expect(src, file).toContain("boxShadow: 'inset 0 0 0 1px var(--np-border-hi), var(--np-shadow-2)'");
    }
    // El aviso de la pantalla del cliente, también.
    expect(rule(read('apps', 'operator', 'src', 'components', 'pantalla', 'pantalla.module.css'), '.toast')).toContain('box-shadow: var(--np-shadow-2);');
    const close = code(read('apps', 'admin', 'src', 'styles', 'panel-close.css'));
    expect(close).toMatch(/@media \(min-width: 900px\) \{[\s\S]*?\.np-close-panel \{[^}]*border-radius: var\(--np-r-card\);[^}]*box-shadow: var\(--np-shadow-2\);/);
  });

  it('lo que va dentro de una tarjeta, a 12: los cobros del saldo en la tarjeta del datáfono', () => {
    const pax = read('apps', 'operator', 'src', 'components', 'pax', 'PaxSaldoFlow.tsx');
    expect(pax).toMatch(/const chargeBtn: CSSProperties = \{[^}]*borderRadius: 'var\(--np-r-inner\)'/);
  });

  it('radios: tarjeta 24, lo de dentro 12, loseta 16; campos y botones del panel no cambian', () => {
    expect(ROOT).toMatchObject({
      '--np-r-card': '24px',
      '--np-r-inner': '12px',
      '--np-r-tile': '16px',
      '--np-r-sm': '10px',
      '--np-r-md': '14px',
      '--np-r-pill': '999px',
    });
    // Radio de fuera = radio de dentro + margen (12 + 12 como mínimo).
    expect(parseInt(ROOT['--np-r-card']!, 10)).toBeGreaterThanOrEqual(parseInt(ROOT['--np-r-inner']!, 10) + 12);
    expect(rule(STYLES, '.np-card .np-card')).toContain('border-radius: var(--np-r-inner);');
  });

  it('sin cristal esmerilado ni resplandores animados en las tarjetas', () => {
    expect(code(STYLES)).not.toMatch(/backdrop-filter/);
    expect(rule(STYLES, '.np-card')).not.toMatch(/animation|filter/);
  });
});

describe('idea 3 · botones en píldora con relieve', () => {
  it('.np-btn es una píldora en los tres tamaños, en el panel, el personal y el TPV', () => {
    expect(rule(STYLES, '.np-btn')).toContain('border-radius: var(--np-r-pill);');
    // Ninguna regla de .np-btn vuelve a poner otro radio (antes, 14 en lo táctil).
    for (const m of code(STYLES).matchAll(/([^{}]*\.np-btn[^{}]*)\{([^}]*)\}/g)) {
      if (m[1]!.trim() !== '.np-btn') expect(m[2], m[1]!.trim()).not.toMatch(/border-radius/);
    }
  });

  it('las alturas no cambian: 36 · 40 · 48 en el panel y 44 · 48 · 56 en lo táctil', () => {
    expect(rule(STYLES, ".np-btn[data-size='sm']")).toContain('height: 2.25rem;');
    expect(rule(STYLES, ".np-btn[data-size='md']")).toContain('height: 2.5rem;');
    expect(rule(STYLES, ".np-btn[data-size='lg']")).toContain('height: 3rem;');
    expect(rule(STYLES, ".np-touch .np-btn[data-size='sm']")).toContain('height: 2.75rem;');
    expect(rule(STYLES, ".np-touch .np-btn[data-size='md']")).toContain('height: 3rem;');
    expect(rule(STYLES, ".np-touch .np-btn[data-size='lg']")).toContain('height: 3.5rem;');
  });

  it('el principal: lima con brillo arriba y sombra con resplandor lima (oscuro)', () => {
    const primary = rule(STYLES, ".np-btn[data-variant='primary']");
    expect(primary).toContain('background-color: var(--np-primary-bg);');
    expect(primary).toContain('background-image: var(--np-primary-image);');
    expect(primary).toContain('box-shadow: var(--np-primary-shadow);');
    expect(primary).toContain('color: var(--np-primary-ink);');
    expect(ROOT['--np-primary-image']).toBe('linear-gradient(180deg, rgba(255, 255, 255, 0.24), rgba(255, 255, 255, 0) 55%)');
    expect(DARK['--np-primary-shadow']).toBe(
      'inset 0 1px 0 rgba(255, 255, 255, 0.45), inset 0 -1px 0 rgba(0, 0, 0, 0.18), 0 1px 2px rgba(0, 0, 0, 0.4), 0 8px 24px -8px rgba(199, 211, 1, 0.5)',
    );
  });

  it('en claro: el mismo brillo interior, con su filete de tinta y sin resplandor lima', () => {
    expect(LIGHT['--np-primary-shadow']).toMatch(/^inset 0 0 0 1px rgba\(21, 25, 28, 0\.7\)/);
    expect(LIGHT['--np-primary-shadow']).not.toMatch(/199[ ,]+211[ ,]+1\b/);
    // El brillo (--np-primary-image) está en :root y no se redefine en claro: es el mismo.
    expect(LIGHT['--np-primary-image']).toBeUndefined();
  });

  it('el secundario: superficie elevada, filete y filo de luz; pulsado, un paso más', () => {
    const ghost = rule(STYLES, ".np-btn[data-variant='ghost']");
    expect(ghost).toContain('background: var(--np-surface-2);');
    expect(ghost).toContain('box-shadow: inset 0 0 0 1px var(--np-border-hi), var(--np-hi);');
    expect(rule(STYLES, ".np-btn[data-variant='ghost']:active:not(:disabled)")).toContain('background: var(--np-surface-3);');
  });

  it('el de peligro: el rojo profundo de siempre con un filo de luz arriba', () => {
    const danger = rule(STYLES, ".np-btn[data-variant='danger']");
    expect(danger).toContain('background: var(--np-outcome-failed);');
    expect(danger).toContain('box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12);');
  });

  it('apagado: neutro, sin transparencia, sin brillo ni sombra de relieve; cargando conserva su color', () => {
    const off = rule(STYLES, '.np-btn:disabled:not([data-loading])');
    expect(off).toContain('background: var(--np-disabled-bg);');
    expect(off).toContain('box-shadow: inset 0 0 0 1px var(--np-disabled-edge);');
    expect(off).not.toMatch(/opacity|--np-primary|--np-hi|gradient/);
    expect(STYLES).toMatch(/\.np-btn\[data-loading\] \{\s*cursor: progress;\s*\}/);
  });

  it('el foco: anillo de 2 px separado 3 px en todos los botones (sobre la lima, pegado no se vería), sin mover nada', () => {
    // Lo pone la regla general; ninguna de .np-btn la pisa (en el panel, panel-grafito.css
    // le cambia solo el color, a crema: una regla de .np-btn con color le quitaba eso).
    const focus = rule(STYLES, ':focus-visible');
    expect(focus).toContain('outline: 2px solid var(--np-accent);');
    expect(focus).toContain('outline-offset: 3px;');
    expect(focus).not.toMatch(/border|padding|margin|transform/);
    for (const m of code(STYLES).matchAll(/([^{}]*\.np-btn[^{}]*)\{([^}]*)\}/g)) expect(m[2], m[1]!.trim()).not.toMatch(/outline/);
    expect(read('apps', 'admin', 'src', 'styles', 'panel-grafito.css')).toMatch(/:focus-visible \{\s*outline-color: var\(--np-focus\);/);
  });

  it('los botones hechos a mano se ven como el común: píldora y las mismas fichas de relieve', () => {
    // Cobrar (la carta, la cuenta, «Otro importe»).
    expect(rule(COBRAR, '.btn')).toContain('border-radius: var(--np-r-pill);');
    const cobrar = rule(COBRAR, '.primary');
    expect(cobrar).toContain('background-image: var(--np-primary-image);');
    expect(cobrar).toContain('box-shadow: var(--np-primary-shadow);');
    expect(rule(COBRAR, '.ghost')).toContain('box-shadow: inset 0 0 0 1px var(--np-border-hi), var(--np-hi);');
    // Recepción (las opciones grandes), OxioParty y la guía.
    const optPri = rule(DESK, '.optPri');
    expect(optPri).toContain('background-image: var(--np-primary-image);');
    expect(optPri).toContain('box-shadow: var(--np-primary-shadow);');
    const party = rule(PARTY, '.cobrar');
    expect(party).toContain('border-radius: var(--np-r-pill);');
    expect(party).toContain('background-image: var(--np-primary-image);');
    expect(party).toContain('box-shadow: var(--np-primary-shadow);');
    const tour = rule(TOUR, ".np-tour-btn[data-kind='primary']");
    expect(tour).toContain('background-image: var(--np-primary-image);');
    expect(tour).toContain('box-shadow: var(--np-primary-shadow);');
    // El resultado a pantalla completa: crema, con el mismo relieve pero sin resplandor lima.
    expect(rule(STAFF, '.np-outcome-btn')).toContain('border-radius: var(--np-r-pill);');
    const outcome = rule(STAFF, ".np-outcome-btn[data-variant='primary']");
    expect(outcome).toContain('background-image: var(--np-primary-image);');
    expect(outcome).toContain('box-shadow: var(--np-btn-relief);');
    expect(ROOT['--np-btn-relief']).toBe('inset 0 1px 0 rgba(255, 255, 255, 0.45), inset 0 -1px 0 rgba(0, 0, 0, 0.18), 0 1px 2px rgba(0, 0, 0, 0.4)');
  });

  it('las opciones grandes de Recepción (dos líneas y su icono) también son píldora, con el relieve del común', () => {
    const opt = rule(DESK, '.opt');
    expect(opt).toContain('border-radius: var(--np-r-pill);');
    expect(opt).toContain('box-shadow: inset 0 0 0 1px var(--np-border-hi), var(--np-hi);');
    // Pulsado, un paso más (como el secundario común), también con el dedo.
    expect(rule(DESK, '.opt:not(.optPri):active:not(:disabled)')).toContain('background: var(--np-surface-3);');
  });

  it('«nada que cobrar» va a trazos con un borde, no con un contorno (en el Chrome viejo del datáfono, el contorno sale cuadrado sobre la píldora)', () => {
    const off = rule(COBRAR, ".primary:disabled:not([aria-busy='true'])");
    expect(off).toContain('border: 1px dashed var(--np-border-hi);');
    expect(off).not.toMatch(/outline/);
  });

  it('un botón hecho a mano apagado no se queda con el brillo ni con el resplandor', () => {
    for (const [css, selector] of [
      [COBRAR, ".btn:disabled:not([aria-busy='true'])"],
      [DESK, '.opt:disabled:not([data-loading])'],
    ] as const) {
      const off = rule(css, selector);
      expect(off, selector).toContain('background: var(--np-disabled-bg);');
      expect(off, selector).toContain('box-shadow: inset 0 0 0 1px var(--np-disabled-edge);');
    }
  });

  it('la píldora es solo de los botones: losetas, teclas, pestañas y campos siguen con su radio', () => {
    expect(rule(COBRAR, '.tile')).toContain('border-radius: var(--np-r-tile);');
    expect(rule(STAFF, '.np-keypad-key')).not.toContain('--np-r-pill');
    const input = read('packages', 'ui', 'src', 'components', 'Input.tsx');
    expect(input).not.toContain('--np-r-pill');
  });
});

describe('idea 11 · colores de sección', () => {
  it.each([
    ['copas', '#46efd4'],
    ['comida', '#fd622d'],
    ['entradas', '#4d94fb'],
    ['servicios', '#ff77a2'],
    ['habitaciones', '#bbb8fe'],
    ['propinas', '#feee82'],
    ['saldo', '#9aa4ad'],
    ['otros', '#7c8893'],
  ] as const)('%s: %s, igual en CSS y en TS, con la tinta encima ≥ 4,5:1', (key, color) => {
    expect(ROOT[`--np-sec-${key}`]).toBe(color);
    expect(SECTIONS[key].color).toBe(color);
    expect(contrast(SECTION_ON_COLOR, color)).toBeGreaterThanOrEqual(4.5);
  });

  it('la tinta de las secciones no cambia y los tonos de loseta siguen a su sección', () => {
    expect(ROOT['--np-on-section']).toBe('#0b0d0e');
    expect(SECTION_ON_COLOR).toBe('#0b0d0e');
    expect(ROOT['--np-sec-servicios-tile']).toBe(ROOT['--np-sec-servicios']);
    expect(ROOT['--np-sec-propinas-tile']).toBe(ROOT['--np-sec-propinas']);
  });

  it('como relleno, punto o icono se ven sobre la tarjeta (≥ 3:1); Comida y Entradas no llegan a texto pequeño sobre lo elevado', () => {
    for (const key of ['copas', 'comida', 'entradas', 'servicios', 'habitaciones', 'propinas'] as const) {
      expect(contrast(SECTIONS[key].color, hex('--np-surface')), key).toBeGreaterThanOrEqual(3);
    }
    // Por eso el texto pequeño nunca va en color de sección: crema con un punto de color.
    expect(contrast(SECTIONS.comida.color, hex('--np-surface-2'))).toBeLessThan(7);
    expect(contrast(SECTIONS.entradas.color, hex('--np-surface-2'))).toBeLessThan(7);
  });
});

describe('idea 12 · lima más viva en pantallas P3', () => {
  const p3 = STYLES.slice(STYLES.indexOf('@supports (color: oklch(0% 0 0))'));

  it('el bloque existe, dentro de @supports y de la consulta de gama P3', () => {
    expect(STYLES).toContain('@supports (color: oklch(0% 0 0))');
    expect(p3).toMatch(/^@supports \(color: oklch\(0% 0 0\)\) \{\s*@media \(color-gamut: p3\) \{\s*:root \{\s*--np-lime: oklch\(82\.9% 0\.215 114\);\s*\}\s*\}\s*\}/);
  });

  it('la lima de respaldo es la de siempre y va antes (un navegador viejo se queda con ella)', () => {
    expect(ROOT['--np-lime']).toBe('#c7d301');
    expect(STYLES.indexOf('--np-lime: #c7d301;')).toBeLessThan(STYLES.indexOf('@supports (color: oklch(0% 0 0))'));
  });

  it('nunca oklch() en una variable fuera de @supports (dejaría la variable vacía en un navegador viejo)', () => {
    const before = code(STYLES.slice(0, STYLES.indexOf('@supports (color: oklch(0% 0 0))')));
    const after = code(p3.slice(p3.indexOf('\n}\n') + 3));
    expect(before).not.toContain('oklch(');
    expect(after).not.toContain('oklch(');
  });

  it('lo que repetía #c7d301 en el tema oscuro apunta a la lima (así le llega la mejora)', () => {
    expect(DARK['--np-accent']).toBe('var(--np-lime)');
    expect(DARK['--np-primary-bg']).toBe('var(--np-lime)');
    expect(code(block(STYLES, ":root,\n[data-theme='dark']"))).not.toContain('#c7d301');
    // Halos y filetes siguen en rgb (la transparencia no se puede sacar de la variable).
    // El filete, con comas: la tarjeta destacada (borde lima) lo usa y en el Chrome 64 se quedaba sin borde.
    expect(ROOT['--np-lime-edge']).toBe('rgba(199, 211, 1, 0.55)');
    expect(DARK['--np-glow']).toBe('rgb(199 211 1 / 0.22)');
  });

  it('fuera de styles.css, lo mismo: el bitcoin del mapa del dinero (oscuro) y el marco del editor de fotos de la carta', () => {
    const money = read('apps', 'admin', 'src', 'styles', 'panel-money.css');
    expect(vars(block(money, ":root,\n[data-theme='dark']"))['--np-mm-bitcoin']).toBe('var(--np-lime)');
    const editor = read('apps', 'admin', 'src', 'components', 'CartaImageEditor.tsx');
    expect(editor).toContain("outline: '3px solid var(--np-lime)'");
    expect(editor.toLowerCase()).not.toContain('#c7d301');
  });
});

describe('compatibilidad con los datáfonos (Chrome 64): lo nuevo no usa nada sin respaldo', () => {
  it('las fichas de relieve y las reglas de .np-btn y .np-card: sin color-mix(), sin inset abreviado, sin :has()', () => {
    const tokens = ['--np-hi', '--np-shadow-1', '--np-shadow-2', '--np-card-edge', '--np-card-fill', '--np-primary-image', '--np-primary-shadow', '--np-btn-relief'];
    for (const theme of [ROOT, DARK, LIGHT]) for (const name of tokens) expect(theme[name] ?? '', name).not.toMatch(/color-mix|oklch|oklab/);
    for (const m of code(STYLES).matchAll(/([^{}]*\.np-(?:btn|card)[^{}]*)\{([^}]*)\}/g)) {
      expect(m[2], m[1]!.trim()).not.toMatch(/color-mix\(|oklch\(|(?:^|[\s;])inset\s*:/);
      expect(m[1], m[1]!.trim()).not.toContain(':has(');
    }
  });

  // rgb(r g b / a), con espacios, es de Chrome 65: en el 64 la declaración entera
  // no vale (un `box-shadow: filete, var(--np-hi)` perdía también el filete y
  // `border: 1px solid var(--np-card-edge)` dejaba la tarjeta sin borde). Lo
  // nuevo va como rgba(r, g, b, a): el mismo color en todos.
  const SPACED_RGB = /rgba?\(\s*\d+\s+\d+\s+\d+\s*(?:\/[^)]*)?\)/;

  it('los colores con transparencia de lo nuevo van como rgba(r, g, b, a), no rgb() con espacios', () => {
    const tokens = ['--np-hi', '--np-shadow-1', '--np-shadow-2', '--np-card-edge', '--np-primary-image', '--np-primary-shadow', '--np-btn-relief', '--np-backdrop', '--np-lime-edge', '--np-accent-edge'];
    for (const [theme, values] of [['raíz', ROOT], ['oscuro', DARK], ['claro', LIGHT], ['sala', SALA]] as const) {
      for (const name of tokens) expect(values[name] ?? '', `${theme} ${name}`).not.toMatch(SPACED_RGB);
    }
    const lightSala = vars(block(STYLES, "html[data-theme='light'][data-contrast='sala']"));
    expect(lightSala['--np-primary-shadow'], 'claro y sala').not.toMatch(SPACED_RGB);
    const day = read('apps', 'operator', 'src', 'app', 'party-day.css');
    for (const selector of ["html[data-theme='day']", "html[data-theme='day'][data-contrast='sala']"]) {
      const values = vars(block(day, selector));
      for (const name of ['--np-primary-shadow', '--np-hi', '--np-shadow-1', '--np-shadow-2']) expect(values[name] ?? '', `${selector} ${name}`).not.toMatch(SPACED_RGB);
    }
    for (const m of code(STYLES).matchAll(/([^{}]*\.np-(?:btn|card)[^{}]*)\{([^}]*)\}/g)) expect(m[2], m[1]!.trim()).not.toMatch(SPACED_RGB);
    expect(rule(TOUR, '.np-tour-spot')).not.toMatch(SPACED_RGB);
    expect(read('apps', 'operator', 'src', 'components', 'pantalla', 'pantalla.module.css')).not.toContain('rgb(3 10 12');
  });
});
