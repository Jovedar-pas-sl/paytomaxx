import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Decisión D11: Manrope variable 600-800 (antes solo 800). Importes y títulos
// siguen en 800; las cifras de las tablas del panel, en 700 (jerarquía).

const ROOT = new URL('../../../../', import.meta.url);
const read = (rel: string): string => readFileSync(new URL(rel, ROOT), 'utf8').replace(/\r\n/g, '\n');

describe('Manrope variable 600-800 (D11)', () => {
  it('las cuatro apps cargan la Manrope del repo con el rango 600-800', () => {
    for (const app of ['admin', 'operator', 'tpv', 'web-client']) {
      const layout = read(`apps/${app}/src/app/layout.tsx`);
      const block = layout.slice(layout.indexOf("fonts/manrope.woff2'"), layout.indexOf("fonts/manrope.woff2'") + 160);
      expect(block, app).toContain("weight: '600 800'");
    }
  });

  it('el fichero es el variable (≈30 KB; el de un solo peso pesaba 17 KB)', () => {
    const size = statSync(new URL('packages/ui/fonts/manrope.woff2', ROOT)).size;
    expect(size).toBeGreaterThan(25_000);
    expect(size).toBeLessThan(35_000);
  });

  it('las cifras siguen en 800 de fábrica; las de las tablas del panel, en 700', () => {
    expect(read('packages/ui/src/styles.css')).toMatch(/\.np-num \{[^}]*font-weight: 800;/);
    expect(read('apps/admin/src/styles/panel-tables.css')).toMatch(/\.np-table \.np-num \{\s*font-weight: 700;/);
  });
});
