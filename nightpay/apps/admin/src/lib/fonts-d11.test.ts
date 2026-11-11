import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Grafito (2-nov-2026): las cifras van en Manrope 600 y 700, así que todas las
// apps cargan la Manrope variable 600-800 como --font-mono. La de un solo peso
// (800) convertía cualquier peso en 800 y no dejaba jerarquía entre cifras. Las
// tablas del panel siguen en 700 (decisión D11), con su variable aparte.

const ROOT = new URL('../../../../', import.meta.url);
const read = (rel: string): string => readFileSync(new URL(rel, ROOT), 'utf8').replace(/\r\n/g, '\n');

describe('Manrope variable en todas las apps (Grafito)', () => {
  it('las cuatro apps cargan la variable 600-800 como --font-mono', () => {
    for (const app of ['admin', 'operator', 'tpv', 'web-client']) {
      const layout = read(`apps/${app}/src/app/layout.tsx`);
      const at = layout.indexOf("fonts/manrope-var.woff2'");
      expect(at, app).toBeGreaterThan(0);
      expect(layout.slice(at, at + 120), app).toContain("weight: '600 800'");
      expect(layout, app).toContain("variable: '--font-mono'");
      expect(layout, app).not.toContain("fonts/manrope.woff2'");
    }
    expect(read('apps/admin/src/app/layout.tsx')).toContain('monoVar.variable}');
  });

  it('la variable pesa ≈30 KB', () => {
    const variable = statSync(new URL('packages/ui/fonts/manrope-var.woff2', ROOT)).size;
    expect(variable).toBeGreaterThan(25_000);
    expect(variable).toBeLessThan(35_000);
  });

  it('las cifras van en Manrope 700 (la maqueta Grafito 3), también las de las tablas del panel', () => {
    expect(read('packages/ui/src/styles.css')).toMatch(/\.np-num \{[^}]*font-weight: 700;/);
    expect(read('apps/admin/src/styles/panel-tables.css')).toMatch(
      /\.np-table \.np-num \{\s*font-family: var\(--font-mono-var\), var\(--np-font-mono\);\s*font-weight: 700;/,
    );
  });
});
