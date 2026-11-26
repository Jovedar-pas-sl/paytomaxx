import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Grafito 3: la pestaña elegida de la barra de abajo va en crema (tinta en el
// tema claro), no en lima; las demás, en t2. Entrega 4 (idea 10): la raya de
// arriba es UNA marca de la barra que se desliza (.np-tabmark en staff.css),
// en lima, ya no una raya dentro de cada pestaña.

const SRC = readFileSync(new URL('../components/TabBar.tsx', import.meta.url), 'utf8');
const ICON = readFileSync(new URL('../../../../packages/ui/src/components/Icon.tsx', import.meta.url), 'utf8');
const STAFF = readFileSync(new URL('../../../../packages/ui/src/staff.css', import.meta.url), 'utf8');

describe('la barra de abajo del personal', () => {
  it('la elegida, en crema (--np-chosen); las demás, en --np-text-mute', () => {
    expect(SRC).toMatch(/const TAB_ACTIVE_COLOR = 'var\(--np-chosen\)';/);
    expect(SRC).toMatch(/const TAB_IDLE_COLOR = 'var\(--np-text-mute\)';/);
    expect(SRC).toMatch(/color: active \? TAB_ACTIVE_COLOR : TAB_IDLE_COLOR/);
  });

  it('el icono sigue el color de la pestaña (currentColor, desde la pieza Icon)', () => {
    expect(SRC).toMatch(/<Icon name=\{TAB_ICON\[tab\]\} \/>/);
    expect(ICON).toMatch(/stroke="currentColor"/);
  });

  it('la raya de arriba es una sola marca de la barra, fuera de TabBtn, y va en lima (24×2)', () => {
    expect(SRC).not.toContain('activeMarkStyle');
    expect(SRC.match(/className="np-tabmark"/g)).toHaveLength(1);
    expect(SRC.indexOf('className="np-tabmark"')).toBeLessThan(SRC.indexOf('function TabBtn'));
    const at = STAFF.indexOf('.np-tabmark::after {');
    const mark = STAFF.slice(at, STAFF.indexOf('}', at));
    expect(mark).toContain('background: var(--np-accent)');
    expect(mark).toContain('width: 1.5rem');
    expect(mark).toContain('height: 2px');
  });
});
