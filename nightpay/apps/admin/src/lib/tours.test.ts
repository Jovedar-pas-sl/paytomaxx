import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PANEL_TABS } from './roles';
import { TAB_TOURS, TOURS } from './tours';

// Los tutoriales del «?» del panel: cada pestaña tiene su botón, cada paso
// apunta a un `data-tour` que existe en el código y ya no queda la ayuda fija
// de Cobros («Cómo leer esta tabla» y su línea).

const SRC = join(process.cwd(), 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx|css)$/.test(name) ? [full] : [];
  });
}

const files = walk(SRC).filter((f) => !/\.test\.(ts|tsx)$/.test(f));
const sources = files.map((f) => ({ file: f, text: readFileSync(f, 'utf8') }));
// «Mi perfil» se pinta con la pantalla común de @nightpay/ui: sus marcas data-tour viven allí.
const sharedProfile = readFileSync(join(SRC, '..', '..', '..', 'packages', 'ui', 'src', 'components', 'ProfileScreen.tsx'), 'utf8');
const code = [...sources.filter((s) => /\.tsx$/.test(s.file)).map((s) => s.text), sharedProfile].join('\n');

/** Las marcas `data-tour="x"`, `'data-tour': 'x'` o `tour="x"` que hay en las pantallas. */
const marks = new Set([...code.matchAll(/(?:data-tour|tour)['"]?\s*[=:][^'"\n]{0,40}['"]([a-z0-9-]+)['"]/g)].map((m) => m[1]!));

const entries = Object.entries(TOURS) as Array<[string, { screen: string; steps: ReadonlyArray<{ target: string; title: string; text: string }> }]>;

/** Pestañas del panel sin tutorial a propósito (no están entre las pantallas pedidas). */
const WITHOUT_TOUR = ['treasury', 'reports', 'oxiopay', 'superadmin'];

describe('los tutoriales del panel', () => {
  it('cada uno tiene de 3 a 6 pasos, con título y texto cortos', () => {
    for (const [key, tour] of entries) {
      expect(tour.steps.length, key).toBeGreaterThanOrEqual(3);
      expect(tour.steps.length, key).toBeLessThanOrEqual(6);
      for (const step of tour.steps) {
        expect(step.title.length, `${key}/${step.target} título`).toBeLessThanOrEqual(32);
        expect(step.text.length, `${key}/${step.target} texto`).toBeLessThanOrEqual(420);
        expect(step.text, `${key}/${step.target}`).not.toMatch(/\bNFC\b|[!¡]/);
      }
    }
  });

  it('cada pantalla tiene su clave de localStorage, sin repetir', () => {
    const screens = entries.map(([, t]) => t.screen);
    expect(new Set(screens).size).toBe(screens.length);
  });

  it('cada paso apunta a un data-tour que existe, y sin repetir en la misma pantalla', () => {
    for (const [key, tour] of entries) {
      const targets = tour.steps.map((s) => s.target);
      expect(new Set(targets).size, `${key} repetidos`).toBe(targets.length);
      for (const t of targets) expect(marks.has(t), `${key}: falta data-tour="${t}"`).toBe(true);
    }
  });

  it('cada pestaña del panel (salvo las apartadas) tiene su tutorial, y el Dashboard pinta su «?»', () => {
    for (const tab of PANEL_TABS) {
      if (WITHOUT_TOUR.includes(tab.key)) continue;
      expect(TAB_TOURS[tab.key], `la pestaña ${tab.key} no tiene tutorial`).toBeDefined();
    }
    const dashboard = readFileSync(join(SRC, 'components', 'Dashboard.tsx'), 'utf8');
    expect(dashboard).toContain('TAB_TOURS[tab]');
    expect(dashboard).toContain('<ScreenHelp key={tab}');
  });

  it('todos los tutoriales se usan: en una pestaña o en su propia pantalla (cierre de la noche)', () => {
    const inTabs = new Set(Object.values(TAB_TOURS).map((t) => t!.screen));
    for (const [key, tour] of entries) {
      if (inTabs.has(tour.screen)) continue;
      expect(code, `${key} sin ScreenHelp`).toContain(`<ScreenHelp {...TOURS.${key}}`);
    }
  });

  it('el cierre de la noche pinta su «?» dentro de su ventana, que no cuenta como otra ventana encima', () => {
    const close = readFileSync(join(SRC, 'components', 'NightCloseScreen.tsx'), 'utf8');
    expect(close).toContain('<ScreenHelp {...TOURS.nightClose}');
    expect(close).toContain('data-tour-host');
  });

  it('el «?» de Cobros nombra los botones de la fila tal cual', () => {
    const cobros = TOURS.payments.steps.find((s) => s.target === 'cobros-acciones')!;
    for (const label of ['Ver detalle', 'Anular cobro', 'Resolver', 'Devolución BBVA', 'Reembolsar', 'Devoluciones']) {
      expect(cobros.text).toContain(`«${label}»`);
    }
  });
});

describe('ya no queda la ayuda fija de Cobros', () => {
  it('ni «Cómo leer esta tabla», ni la línea de ayuda, ni sus estilos', () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/CobrosHowTo|np-howto|np-help-line|COBROS_HINT|Cómo leer esta tabla|HelpLine|np-ayuda/);
    }
    expect(existsSync(join(SRC, 'components', 'CobrosHowTo.tsx'))).toBe(false);
    expect(existsSync(join(SRC, 'styles', 'panel-help.css'))).toBe(false);
  });
});
