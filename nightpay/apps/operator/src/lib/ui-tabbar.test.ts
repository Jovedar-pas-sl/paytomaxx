import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Grafito 3: la pestaña elegida de la barra de abajo va en crema (tinta en el
// tema claro), no en lima; las demás, en t2.

const SRC = readFileSync(new URL('../components/TabBar.tsx', import.meta.url), 'utf8');

describe('la barra de abajo del personal', () => {
  it('la elegida, en crema (--np-chosen); las demás, en --np-text-mute', () => {
    expect(SRC).toMatch(/const TAB_ACTIVE_COLOR = 'var\(--np-chosen\)';/);
    expect(SRC).toMatch(/const TAB_IDLE_COLOR = 'var\(--np-text-mute\)';/);
    expect(SRC).toMatch(/color: active \? TAB_ACTIVE_COLOR : TAB_IDLE_COLOR/);
  });

  it('el icono y la raya de arriba siguen el color de la pestaña (currentColor)', () => {
    expect(SRC).toMatch(/stroke="currentColor"/);
    expect(SRC).toMatch(/const activeMarkStyle[^}]*background: 'currentColor'/);
  });
});
