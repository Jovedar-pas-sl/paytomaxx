import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Decisión D11: en el panel, Manrope variable 600-800 (importes y títulos en
// 800, cifras de las tablas en 700: jerarquía). Las apps del personal y las
// páginas del cliente siguen con la de 800 (17 KB): su aspecto no cambia.

const ROOT = new URL('../../../../', import.meta.url);
const read = (rel: string): string => readFileSync(new URL(rel, ROOT), 'utf8').replace(/\r\n/g, '\n');

describe('Manrope variable 600-800 en el panel (D11)', () => {
  it('el panel carga la variable (600-800); las apps del personal y el TPV, la de 800', () => {
    const admin = read('apps/admin/src/app/layout.tsx');
    const at = admin.indexOf("fonts/manrope-var.woff2'");
    expect(at).toBeGreaterThan(0);
    expect(admin.slice(at, at + 80)).toContain("weight: '600 800'");
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

  it('las cifras siguen en 800 de fábrica; las de las tablas del panel, en 700', () => {
    expect(read('packages/ui/src/styles.css')).toMatch(/\.np-num \{[^}]*font-weight: 800;/);
    expect(read('apps/admin/src/styles/panel-tables.css')).toMatch(/\.np-table \.np-num \{\s*font-weight: 700;/);
  });
});
