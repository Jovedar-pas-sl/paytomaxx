import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOURS } from '../../../tpv/src/lib/tours';

// Los tutoriales del TPV (la app no tiene pruebas propias: se comprueban desde
// aquí, como ui-grafito-restos.test.ts): cada pantalla tiene su «?», sus pasos
// apuntan a un data-tour que existe y no queda ninguna ayuda fija.

const TPV_SRC = join(process.cwd(), '..', 'tpv', 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx|css)$/.test(name) ? [full] : [];
  });
}

const sources = walk(TPV_SRC).map((file) => ({ file, text: readFileSync(file, 'utf8') }));
const code = sources.filter((s) => s.file.endsWith('.tsx')).map((s) => s.text).join('\n');
const marks = new Set([...code.matchAll(/(?:data-tour|tour)['"]?\s*[=:][^'"\n]{0,40}['"]([a-z0-9-]+)['"]/g)].map((m) => m[1]!));

describe('los tutoriales del TPV', () => {
  it('cobro y espera, de 3 a 6 pasos cada uno, con su clave de localStorage', () => {
    expect(Object.keys(TOURS).sort()).toEqual(['cobro', 'espera']);
    const screens = Object.values(TOURS).map((t) => t.screen);
    expect(new Set(screens).size).toBe(2);
    for (const [key, tour] of Object.entries(TOURS)) {
      expect(tour.steps.length, key).toBeGreaterThanOrEqual(3);
      expect(tour.steps.length, key).toBeLessThanOrEqual(6);
      for (const step of tour.steps) expect(step.text, `${key}/${step.target}`).not.toMatch(/\bNFC\b|[!¡]/);
    }
  });

  it('cada paso apunta a un data-tour que existe', () => {
    for (const [key, tour] of Object.entries(TOURS)) {
      for (const step of tour.steps) expect(marks.has(step.target), `${key}: falta data-tour="${step.target}"`).toBe(true);
    }
  });

  it('la cabecera pinta el «?» de la pantalla que se ve; la espera, solo a mano (hay un cobro abierto)', () => {
    expect(code).toContain('<ScreenHelp key="cobro" {...TOURS.cobro}');
    expect(code).toContain('<ScreenHelp key="espera" {...TOURS.espera} ready={false} />');
    expect(code).toMatch(/<ScreenHelp key="cobro" \{\.\.\.TOURS\.cobro\} ready=\{[^}]*amountCents === 0/);
  });

  it('no hay ninguna ayuda fija', () => {
    for (const { file, text } of sources) expect(text, file).not.toMatch(/HelpLine|HelpAgain|np-ayuda|help-line/);
  });
});
