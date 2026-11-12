import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOURS } from './tours';

// Los tutoriales del «?»: cada pantalla tiene su botón, cada paso apunta a un
// `data-tour` que existe en el código y ya no queda ninguna ayuda fija de las
// que se cerraban con «Entendido».

const SRC = join(process.cwd(), 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx|css)$/.test(name) ? [full] : [];
  });
}

const files = walk(SRC).filter((f) => !/\.test\.(ts|tsx)$/.test(f));
const read = (f: string) => readFileSync(f, 'utf8');
const sources = files.map((f) => ({ file: f, text: read(f) }));
// «Mi perfil» se pinta con la pantalla común de @nightpay/ui: sus marcas data-tour viven allí.
const sharedProfile = readFileSync(join(SRC, '..', '..', '..', 'packages', 'ui', 'src', 'components', 'ProfileScreen.tsx'), 'utf8');
const code = [...sources.filter((s) => /\.tsx$/.test(s.file) && !s.file.endsWith('tours.ts')).map((s) => s.text), sharedProfile].join('\n');

/** Las marcas `data-tour="x"`, `'data-tour': 'x'` o `tour="x"` que hay en las pantallas. */
const marks = new Set([...code.matchAll(/(?:data-tour|tour)['"]?\s*[=:][^'"\n]{0,40}['"]([a-z0-9-]+)['"]/g)].map((m) => m[1]!));

const entries = Object.entries(TOURS) as Array<[string, { screen: string; steps: ReadonlyArray<{ target: string; title: string; text: string }>; manualOnly?: boolean }]>;

describe('los tutoriales del personal', () => {
  it('cada uno tiene de 3 a 6 pasos, con título y texto cortos', () => {
    for (const [key, tour] of entries) {
      expect(tour.steps.length, key).toBeGreaterThanOrEqual(3);
      expect(tour.steps.length, key).toBeLessThanOrEqual(6);
      for (const step of tour.steps) {
        expect(step.title.length, `${key}/${step.target} título`).toBeLessThanOrEqual(30);
        expect(step.text.length, `${key}/${step.target} texto`).toBeLessThanOrEqual(260);
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

  it('cada pantalla pinta su «?» (ScreenHelp con su tutorial)', () => {
    for (const [key] of entries) expect(code, `${key} sin ScreenHelp`).toContain(`TOURS.${key}`);
  });

  it('en las que son un cobro o un resultado, el tutorial no sale solo (ready={false})', () => {
    for (const [key, tour] of entries) {
      if (!tour.manualOnly) continue;
      expect(code, key).toContain(`<ScreenHelp {...TOURS.${key}} ready={false} />`);
    }
  });

  it('las de una pantalla con cobros en curso esperan a que esté libre (ready con condición)', () => {
    for (const key of ['cobrar', 'cuenta', 'cobros', 'ganancias', 'recepcionLectura']) {
      const at = code.indexOf(`<ScreenHelp {...TOURS.${key}} ready={`);
      expect(at, key).toBeGreaterThan(-1);
      expect(code.slice(at, at + 90), key).not.toContain('ready={false}');
    }
  });
});

describe('ya no quedan las ayudas fijas', () => {
  it('ni HelpLine, ni HelpAgain, ni useHelp, ni las claves np-ayuda-*', () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/HelpLine|HelpAgain|useHelp\b|np-ayuda|help-line/);
    }
    expect(existsSync(join(SRC, 'components', 'HelpLine.tsx'))).toBe(false);
    expect(existsSync(join(SRC, 'lib', 'help-line.ts'))).toBe(false);
  });
});
