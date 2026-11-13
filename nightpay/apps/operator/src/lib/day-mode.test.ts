import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DAY_INIT_SCRIPT, DAY_MODE_KEY, DAY_PALETTE, contrastRatio, readDayMode, writeDayMode } from './day-mode';

// OxioParty · «Modo día» (para el sol): una preferencia de este móvil que pone
// data-theme="day" en <html> y cambia las --np-* solo en la app del personal.

const CSS = readFileSync(new URL('../app/party-day.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    data,
  };
}

const throwing = {
  getItem: () => {
    throw new Error('bloqueado');
  },
  setItem: () => {
    throw new Error('bloqueado');
  },
  removeItem: () => {
    throw new Error('bloqueado');
  },
};

describe('la preferencia del modo día (localStorage)', () => {
  it('se guarda y se lee en este móvil', () => {
    const store = memoryStore();
    expect(readDayMode(store)).toBe(false);
    writeDayMode(store, true);
    expect(store.data.get(DAY_MODE_KEY)).toBe('1');
    expect(readDayMode(store)).toBe(true);
    writeDayMode(store, false);
    expect(store.data.has(DAY_MODE_KEY)).toBe(false);
    expect(readDayMode(store)).toBe(false);
  });

  it('con el almacenamiento bloqueado (modo privado) no rompe: se queda la noche', () => {
    expect(readDayMode(throwing)).toBe(false);
    expect(() => writeDayMode(throwing, true)).not.toThrow();
    expect(readDayMode(null)).toBe(false);
    expect(() => writeDayMode(null, true)).not.toThrow();
  });

  it('el arranque lo pone antes de pintar, dentro de un try (sin almacenamiento, nada)', () => {
    expect(DAY_INIT_SCRIPT).toMatch(/^try\{/);
    expect(DAY_INIT_SCRIPT).toContain(`localStorage.getItem('${DAY_MODE_KEY}')==='1'`);
    expect(DAY_INIT_SCRIPT).toContain("setAttribute('data-theme','day')");
    expect(DAY_INIT_SCRIPT).toMatch(/catch\(e\)\{\}$/);
  });
});

describe('los colores de día (maqueta aprobada)', () => {
  it('fondo #F3F1EC, superficie #FFFFFF, línea #E0DBD1; texto #14181B, #3F474E y #5C656D; botón en tinta con lima', () => {
    const start = CSS.indexOf("html[data-theme='day'] {");
    const block = CSS.slice(start, CSS.indexOf('\n}\n', start));
    expect(block).toContain('--np-bg: #f3f1ec;');
    expect(block).toContain('--np-surface: #ffffff;');
    expect(block).toContain('--np-border: #e0dbd1;');
    expect(block).toContain('--np-text: #14181b;');
    expect(block).toContain('--np-text-mute: #3f474e;');
    expect(block).toContain('--np-text-dim: #5c656d;');
    expect(block).toContain('--np-primary-bg: #14181b;');
    expect(block).toContain('--np-primary-ink: #c7d301;');
  });

  it('solo con data-theme="day" (OxioPay nunca lo pone): no toca :root ni los temas de siempre', () => {
    const selectors = CSS.match(/^[^\s/*}][^{}]*\{/gm) ?? [];
    expect(selectors.length).toBeGreaterThan(0);
    for (const sel of selectors) expect(sel).toMatch(/^html\[data-theme='day'\]/);
  });

  it.each([
    ['t1 sobre el fondo', DAY_PALETTE.t1, DAY_PALETTE.bg],
    ['t1 sobre la superficie', DAY_PALETTE.t1, DAY_PALETTE.surface],
    ['t2 sobre el fondo', DAY_PALETTE.t2, DAY_PALETTE.bg],
    ['t2 sobre la superficie', DAY_PALETTE.t2, DAY_PALETTE.surface],
    ['t3 sobre el fondo', DAY_PALETTE.t3, DAY_PALETTE.bg],
    ['t3 sobre la superficie', DAY_PALETTE.t3, DAY_PALETTE.surface],
    ['lima sobre la tinta (el botón principal)', DAY_PALETTE.onAction, DAY_PALETTE.action],
    ['blanco sobre la tinta (lo elegido)', DAY_PALETTE.chosenInk, DAY_PALETTE.action],
    ['«En línea» sobre su píldora', DAY_PALETTE.ok, DAY_PALETTE.okBg],
    ['el aviso sobre su píldora', DAY_PALETTE.warn, DAY_PALETTE.warnBg],
    ['el error sobre el fondo', DAY_PALETTE.danger, DAY_PALETTE.bg],
    ['el botón apagado (t2 sobre la línea)', DAY_PALETTE.t2, DAY_PALETTE.line],
  ])('%s: al menos 4,5:1', (_name, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('el contraste se calcula como WCAG 2 (negro sobre blanco 21:1; igual sobre igual 1:1)', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#C7D301', '#C7D301')).toBeCloseTo(1, 5);
  });

  it('el CSS usa los mismos colores que se comprueban', () => {
    const lower = CSS.toLowerCase();
    for (const c of [DAY_PALETTE.bg, DAY_PALETTE.surface, DAY_PALETTE.line, DAY_PALETTE.t1, DAY_PALETTE.t2, DAY_PALETTE.t3, DAY_PALETTE.onAction]) {
      expect(lower).toContain(c.toLowerCase());
    }
  });
});
