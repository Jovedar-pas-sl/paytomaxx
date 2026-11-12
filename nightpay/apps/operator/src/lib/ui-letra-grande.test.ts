import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// «Letra más grande» (Mi perfil, Este móvil): sube un paso la escala --np-fs-*
// con html[data-bigfont='1'], sin tocar los importes (40 y 64, que se ajustan
// al ancho) ni salirse de la escala por abajo.

const css = readFileSync(new URL('../../../../packages/ui/src/styles.css', import.meta.url), 'utf8');
const block = /html\[data-bigfont='1'\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
const rem = (s: string, name: string): number => Number(new RegExp(`${name}:\\s*([\\d.]+)rem`).exec(s)?.[1]);

describe('letra más grande', () => {
  it('existe el bloque y sube cada tamaño de 14 a 28 un paso', () => {
    expect(block).not.toBe('');
    const base = css.replace(/html\[data-bigfont='1'\]\s*\{[^}]*\}/, '');
    for (const n of [14, 16, 18, 22, 28]) {
      expect(rem(block, `--np-fs-${n}`), `--np-fs-${n}`).toBeGreaterThan(rem(base, `--np-fs-${n}`));
    }
  });

  it('no toca los importes (40 y 64)', () => {
    expect(block).not.toMatch(/--np-fs-(40|64)/);
  });

  it('los pasos siguen en orden: cada tamaño es mayor que el anterior', () => {
    const sizes = [14, 16, 18, 22, 28].map((n) => rem(block, `--np-fs-${n}`));
    expect([...sizes].sort((a, b) => a - b)).toEqual(sizes);
    expect(new Set(sizes).size).toBe(sizes.length);
  });
});
