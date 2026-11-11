import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Grafito 3 en la app del personal, el TPV y los componentes compartidos:
// lo ELEGIDO en crema, la carta, el botón que se hunde y «¿Cómo paga?».
// (La escala de letra está en ui-escala.test.ts.)

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const STYLES = read('../../../../packages/ui/src/styles.css');
const STAFF = read('../../../../packages/ui/src/staff.css');
const COBRAR = read('../components/cobrar/cobrar.module.css');
const DESK = read('../components/reception/desk/desk.module.css');
const TABBAR = read('../components/TabBar.tsx');
const PENDING = read('../components/PendingPos.tsx');

/** El cuerpo de la primera regla con ese selector exacto. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no está ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

/** Los tokens de un tema: el bloque que empieza en `marker`. */
function themeBlock(marker: string): string {
  const start = STYLES.indexOf(marker);
  if (start < 0) throw new Error(`no está ${marker}`);
  return STYLES.slice(start, STYLES.indexOf('\n}\n', start));
}

function hexOf(block: string, name: string): string {
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
  if (!m) throw new Error(`no está ${name}`);
  return m[1]!.toLowerCase();
}

function luminance(hex: string): number {
  const lin = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(1) + 0.7152 * lin(3) + 0.0722 * lin(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('punto 2: la lima solo para lo que se toca; lo elegido, en crema', () => {
  it('lo elegido es crema con tinta en oscuro y tinta con crema en claro', () => {
    expect(STYLES).toMatch(/--np-chosen:\s*var\(--np-cream\);\s*--np-on-chosen:\s*var\(--np-ink\);/);
    expect(STYLES).toMatch(/\[data-theme='light'\][\s\S]*--np-chosen:\s*var\(--np-ink\);\s*--np-on-chosen:\s*var\(--np-cream\);/);
  });

  it('la pestaña de abajo elegida va en crema, no en lima', () => {
    expect(TABBAR).toContain("const TAB_ACTIVE_COLOR = 'var(--np-chosen)'");
    expect(TABBAR).not.toMatch(/np-accent|np-lime/);
  });

  it('los filtros de zona, los motivos y los chips elegidos usan --np-chosen', () => {
    const active = PENDING.slice(PENDING.indexOf('const zoneTabActiveStyle'));
    expect(active.slice(0, 200)).toContain("background: 'var(--np-chosen)'");
    expect(active.slice(0, 200)).toContain("color: 'var(--np-on-chosen)'");
    expect(read('../components/reception/CashVoids.tsx')).toContain("background: 'var(--np-chosen)'");
    for (const sel of ['.segBtn[aria-pressed=\'true\']', '.amt[aria-pressed=\'true\']']) {
      expect(rule(DESK, sel)).toContain('background: var(--np-chosen)');
    }
    expect(rule(STAFF, ".np-seg-btn[aria-pressed='true']")).toContain('background: var(--np-chosen)');
    expect(rule(COBRAR, ".torch[aria-pressed='true']")).toContain('background: var(--np-chosen)');
  });

  it('el código de referencia ya no va en lima', () => {
    const ref = PENDING.slice(PENDING.indexOf('const refStyle'), PENDING.indexOf('const metaStyle'));
    expect(ref).not.toMatch(/np-accent/);
  });

  it('el estado «Barra» (el chip del puesto) es neutro, con filete: no lleva fondo lima', () => {
    const chip = rule(COBRAR, '.chip');
    expect(chip).toContain('background: transparent');
    expect(chip).toContain('inset 0 0 0 1px var(--np-border)');
    expect(chip).not.toMatch(/lime|accent/);
  });
});

describe('punto 3: la carta', () => {
  it('nombre a 14/500 y precio a 16 en Manrope 700', () => {
    expect(rule(COBRAR, '.tileName')).toMatch(/font: 500 var\(--np-fs-14\)/);
    expect(rule(COBRAR, '.price')).toMatch(/font: 700 var\(--np-fs-16\)/);
  });

  it('loseta de 76 px y cuadrado de 44 px en todas las alturas (sin la regla de móviles bajos)', () => {
    expect(rule(COBRAR, '.tile.tileItem')).toContain('min-height: 4.75rem');
    const thumb = rule(COBRAR, '.thumb');
    expect(thumb).toContain('width: 2.75rem');
    expect(thumb).toContain('height: 2.75rem');
    expect(COBRAR).not.toContain('.tileItem .thumb');
    expect(COBRAR).not.toMatch(/5\.75rem|3\.25rem/);
  });

  it('el cuadrado de la imagen mide 44', () => {
    expect(read('./carta-thumb.ts')).toContain('THUMB_SIZE = 44');
  });
});

describe('punto 4: el botón que se hunde', () => {
  it('90 ms y scale(0.96) como tokens', () => {
    expect(STYLES).toContain('--np-press-scale: 0.96');
    expect(STYLES).toContain('--np-press-ms: 90ms');
  });

  it('losetas, teclas y botones principales se hunden con esos tokens', () => {
    expect(rule(COBRAR, '.tile:active')).toContain('scale(var(--np-press-scale))');
    expect(STYLES).toMatch(/\.np-btn:active:not\(:disabled\) \{\s*transform: scale\(var\(--np-press-scale\)\)/);
    expect(STAFF).toMatch(/\.np-keypad-key:active:not\(:disabled\) \{\s*transform: scale\(var\(--np-press-scale\)\)/);
    expect(STYLES).toMatch(/\.np-press:active:not\(:disabled\) \{\s*transform: scale\(var\(--np-press-scale\)\)/);
  });

  it('con «reducir movimiento» no se hunde ni anima', () => {
    const reduced = STYLES.slice(STYLES.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('transition-duration: 0.01ms !important');
    expect(reduced).toMatch(/button:active[\s\S]*transform: none !important/);
  });

  it('se vibra al añadir a la cuenta, al cobrar y al confirmar', () => {
    const flow = read('../components/cobrar/CobrarFlow.tsx');
    expect(flow).toMatch(/function pickItem[\s\S]*?haptic\(\);/);
    expect(flow).toMatch(/async function start[\s\S]*?haptic\(\);/);
    expect(read('../components/cobrar/PinScreen.tsx')).toContain('haptic(');
  });
});

describe('punto 7: «¿Cómo paga?» en dos bloques', () => {
  const light = themeBlock("[data-theme='light'] {");

  it('colores exactos de la maqueta en oscuro', () => {
    expect(hexOf(STYLES, '--np-cash-bg')).toBe('#0f2a1b');
    expect(hexOf(STYLES, '--np-cash-line')).toBe('#58d68d');
    expect(hexOf(STYLES, '--np-card-bg')).toBe('#0f1f31');
    expect(hexOf(STYLES, '--np-card-line')).toBe('#6fa8dc');
  });

  it('dos columnas iguales, borde de 2 px y ninguno marcado', () => {
    expect(rule(DESK, '.methods')).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
    expect(rule(DESK, '.method')).toContain('border: 2px solid var(--m-line)');
    const steps = read('../components/reception/desk/DeskSteps.tsx');
    const block = steps.slice(steps.indexOf('className={s.methods}'), steps.indexOf('{[...new Set(problems)]'));
    expect(block).toContain('<MethodBlock');
    expect(block).not.toMatch(/primary|kind=/);
    expect(rule(DESK, ".method[data-method='cash']")).toContain('--np-cash-bg');
    expect(rule(DESK, ".method[data-method='card']")).toContain('--np-card-bg');
  });

  it('el icono (56 px) lleva el color del método', () => {
    const icon = rule(DESK, '.methodIcon');
    expect(icon).toContain('width: 3.5rem');
    expect(icon).toContain('background: var(--m-line)');
  });

  it('contraste en los dos temas: texto sobre el bloque, aclaración y tinta del icono', () => {
    const dark = STYLES.slice(0, STYLES.indexOf("[data-theme='light'] {"));
    const themes: Array<[string, string, string]> = [
      ['oscuro', dark, '#f4f2ec'],
      ['claro', light, '#15191c'],
    ];
    for (const [name, css, text] of themes) {
      for (const m of ['cash', 'card']) {
        const bg = hexOf(css, `--np-${m}-bg`);
        const line = hexOf(css, `--np-${m}-line`);
        expect(contrast(text, bg), `${name} ${m} texto`).toBeGreaterThanOrEqual(7);
        expect(contrast(hexOf(css, `--np-${m}-sub`), bg), `${name} ${m} aclaración`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(hexOf(css, `--np-${m}-icon-ink`), line), `${name} ${m} icono`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(line, bg), `${name} ${m} borde`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
