import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Decisión D11: las cifras de las tablas del panel en Manrope 700, con la
// Manrope variable 600-800 solo para ellas (--font-mono-var). Todo lo demás
// (importes grandes, títulos, las apps del personal y las páginas del
// cliente) sigue con la de 800 (17 KB): su aspecto no cambia.

const ROOT = new URL('../../../../', import.meta.url);
const read = (rel: string): string => readFileSync(new URL(rel, ROOT), 'utf8').replace(/\r\n/g, '\n');

describe('Manrope variable 600-800 solo para las tablas del panel (D11)', () => {
  it('el panel carga la de 800 para --font-mono y la variable aparte; el resto de apps, solo la de 800', () => {
    const admin = read('apps/admin/src/app/layout.tsx');
    const at = admin.indexOf("fonts/manrope-var.woff2'");
    expect(at).toBeGreaterThan(0);
    expect(admin.slice(at, at + 120)).toContain("weight: '600 800'");
    expect(admin.slice(at, at + 120)).toContain("variable: '--font-mono-var'");
    expect(admin).toContain('monoVar.variable}');
    const mono = admin.indexOf("fonts/manrope.woff2'");
    expect(admin.slice(mono, mono + 120)).toContain("variable: '--font-mono'");
    expect(admin.slice(mono, mono + 120)).toContain("weight: '800'");
    for (const app of ['operator', 'tpv', 'web-client']) {
      const layout = read(`apps/${app}/src/app/layout.tsx`);
      const i = layout.indexOf("fonts/manrope.woff2'");
      expect(layout.slice(i, i + 80), app).toContain("weight: '800'");
    }
  });

  it('la variable pesa ≈30 KB y la de 800 sigue en ≈17 KB', () => {
    const variable = statSync(new URL('packages/ui/fonts/manrope-var.woff2', ROOT)).size;
    expect(variable).toBeGreaterThan(25_000);
    expect(variable).toBeLessThan(35_000);
    expect(statSync(new URL('packages/ui/fonts/manrope.woff2', ROOT)).size).toBeLessThan(20_000);
  });

  it('las cifras siguen en 800 de fábrica; las de las tablas del panel, en 700 con la variable', () => {
    expect(read('packages/ui/src/styles.css')).toMatch(/\.np-num \{[^}]*font-weight: 800;/);
    expect(read('apps/admin/src/styles/panel-tables.css')).toMatch(
      /\.np-table \.np-num \{\s*font-family: var\(--font-mono-var\), var\(--np-font-mono\);\s*font-weight: 700;/,
    );
  });
});
