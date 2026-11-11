import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Grafito 3 · punto 1: una sola escala de letra (64 · 40 · 28 · 22 · 18 · 16 · 14)
// en la app del personal, el TPV y los componentes compartidos. Nunca menos de
// 14 px y solo dos pesos (400 y 600; 500 en la carta); las cifras, Manrope 700.

const ROOTS = ['../../', '../../../tpv/src/', '../../../../packages/ui/src/'].map((r) => new URL(r, import.meta.url));
const SCALE = [64, 40, 28, 22, 18, 16, 14];

function files(dir: URL): string[] {
  const root = fileURLToPath(dir);
  return (readdirSync(root, { recursive: true }) as string[])
    .map((rel) => join(root, rel))
    .filter((f) => !/node_modules|[\\/]\.next[\\/]/.test(f) && /\.(css|tsx)$/.test(f) && !/\.test\./.test(f) && statSync(f).isFile());
}

const STYLES = new URL('../../../../packages/ui/src/styles.css', import.meta.url);
const ALL = ROOTS.flatMap((r) => files(r));
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '');

describe('escala de letra de Grafito 3', () => {
  it('encuentra los ficheros (la prueba no pasa en vacío)', () => {
    expect(ALL.length).toBeGreaterThan(100);
  });

  it('los tokens --np-fs-N son exactamente los siete de la escala', () => {
    const css = readFileSync(STYLES, 'utf8');
    const px = [...css.matchAll(/--np-fs-(\d+):\s*([\d.]+)rem/g)].map((m) => [Number(m[1]), Number(m[2]) * 16]);
    expect(px.map(([n]) => n)).toEqual(SCALE);
    for (const [n, p] of px) expect(p).toBe(n);
  });

  it('ningún tamaño suelto: todo font-size / fontSize / font usa --np-fs-N o un token --np-t-*', () => {
    const bad: string[] = [];
    for (const f of ALL) {
      code(readFileSync(f, 'utf8'))
        .split('\n')
        .forEach((line, i) => {
          const m = /font-size:\s*([^;]+);|fontSize:\s*([^,}]+)|font:\s*(?:[a-z]+\s+)?\d{3}\s+([^\s/;]+)/.exec(line);
          if (!m) return;
          const v = (m[1] ?? m[2] ?? m[3]) as string;
          if (/^(inherit|100%|112\.5%|106\.25%)/.test(v.trim())) return;
          if (/--np-fs-\d+|--np-t-|--np-hero-when|min\(|clamp\(|fitAmount|\bsize\b/.test(v)) return;
          bad.push(`${f}:${i + 1} ${line.trim()}`);
        });
    }
    expect(bad).toEqual([]);
  });

  it('en los min() y clamp() de importes solo entran tamaños de la escala', () => {
    const bad: string[] = [];
    for (const f of ALL) {
      code(readFileSync(f, 'utf8'))
        .split('\n')
        .forEach((line, i) => {
          if (!/font(-size)?:|fontSize:/.test(line) || !/(min|clamp)\(/.test(line)) return;
          for (const m of line.matchAll(/(\d*\.?\d+)rem/g)) {
            if (!SCALE.includes(Number(m[1]) * 16)) bad.push(`${f}:${i + 1} ${line.trim()}`);
          }
        });
    }
    expect(bad).toEqual([]);
  });

  it('el token de etiquetas ya no baja de 14 px', () => {
    const css = readFileSync(STYLES, 'utf8');
    expect(css).toMatch(/--np-t-label:\s*var\(--np-fs-14\)/);
  });

  it('sin pesos 800/900, y el 700 solo en cifras (Manrope)', () => {
    const bad: string[] = [];
    for (const f of ALL) {
      const text = code(readFileSync(f, 'utf8'));
      if (/font-weight:\s*[89]00|fontWeight:\s*'?[89]00|font:\s*[89]00/.test(text)) bad.push(f);
    }
    expect(bad).toEqual([]);
  });
});
