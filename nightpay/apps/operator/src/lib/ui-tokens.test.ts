import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Los grises y bordes de @nightpay/ui medidos (revisión visual de 2026-10-23):
// si alguien los vuelve a bajar, esta prueba lo dice. WCAG 2.x: 4,5:1 texto,
// 3:1 bordes de lo que se toca (1.4.11); para las ayudas pequeñas en oscuro
// se pide 7:1 (lo que Apple pide a los colores propios con letra pequeña).

// Sin \r: en Windows git deja los ficheros con CRLF.
const STYLES = readFileSync(new URL('../../../../packages/ui/src/styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** Las variables hex de un bloque de styles.css (el que empieza por `selector {`). */
function tokens(selector: string): Record<string, string> {
  const start = STYLES.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no está el bloque ${selector}`);
  const body = STYLES.slice(start, STYLES.indexOf('\n}', start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--np-[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]!] = m[2]!.toLowerCase();
  return out;
}

function contrast(a: string, b: string): number {
  const lum = (hex: string): number => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const DARK = tokens(":root,\n[data-theme='dark']");
const LIGHT = tokens("[data-theme='light']");

describe('grises y bordes del tema oscuro', () => {
  const t = DARK;
  it('textos secundarios: ayudas ≥ 7:1 sobre el fondo y ≥ 6:1 aún sobre surface-3', () => {
    expect(contrast(t['--np-text-dim']!, t['--np-bg']!)).toBeGreaterThanOrEqual(7);
    expect(contrast(t['--np-text-dim']!, t['--np-surface-3']!)).toBeGreaterThanOrEqual(6);
    expect(contrast(t['--np-text-mute']!, t['--np-bg']!)).toBeGreaterThanOrEqual(11);
    expect(contrast(t['--np-text-label']!, t['--np-surface-2']!)).toBeGreaterThanOrEqual(10);
  });

  it('el borde de lo que se toca se ve: ≥ 3:1 sobre el fondo y las superficies', () => {
    for (const bg of ['--np-bg', '--np-surface', '--np-surface-2']) {
      expect(contrast(t['--np-border-hi']!, t[bg]!), bg).toBeGreaterThanOrEqual(3);
    }
  });

  it('el rojo de los errores pequeños se lee (≥ 7:1)', () => {
    expect(contrast(t['--np-danger-text']!, t['--np-bg']!)).toBeGreaterThanOrEqual(7);
    expect(contrast(t['--np-danger-text']!, t['--np-surface']!)).toBeGreaterThanOrEqual(7);
  });
});

describe('grises y bordes del tema claro', () => {
  const t = LIGHT;
  it('ayudas ≥ 5:1 sobre la crema y sobre surface-2', () => {
    expect(contrast(t['--np-text-dim']!, t['--np-bg']!)).toBeGreaterThanOrEqual(5);
    expect(contrast(t['--np-text-dim']!, t['--np-surface-2']!)).toBeGreaterThanOrEqual(5);
    expect(contrast(t['--np-success']!, t['--np-bg']!)).toBeGreaterThanOrEqual(6);
    expect(contrast(t['--np-danger-text']!, t['--np-bg']!)).toBeGreaterThanOrEqual(4.5);
  });

  it('el borde de lo que se toca se ve: ≥ 3:1 sobre la crema y las superficies', () => {
    for (const bg of ['--np-bg', '--np-surface', '--np-surface-2']) {
      expect(contrast(t['--np-border-hi']!, t[bg]!), bg).toBeGreaterThanOrEqual(3);
    }
  });

  it('la pill lima lleva borde de tinta (no se funde con la crema)', () => {
    expect(STYLES).toMatch(/--np-primary-shadow: inset 0 0 0 1\.5px rgb\(31 44 54 \/ 0\.7\)/);
  });
});

describe('botón sin nada que hacer', () => {
  it('gris y a trazos, nunca lima apagada (solo el principal y no mientras carga)', () => {
    const rule = /\.np-btn\[data-variant='primary'\]:disabled:not\(\[data-loading\]\) \{([^}]*)\}/.exec(STYLES)?.[1] ?? '';
    expect(rule).toContain('background: var(--np-disabled-bg)');
    expect(rule).toContain('dashed var(--np-disabled-edge)');
    expect(rule).toContain('opacity: 1');
    // El texto del botón vacío se lee en los dos temas.
    expect(contrast(DARK['--np-text-dim']!, DARK['--np-surface-2']!)).toBeGreaterThanOrEqual(7);
    expect(contrast(LIGHT['--np-text-dim']!, LIGHT['--np-surface-2']!)).toBeGreaterThanOrEqual(5);
  });

  it('el halo del lima, contenido', () => {
    expect(STYLES).toMatch(/--np-lime-glow: rgb\(199 211 1 \/ 0\.32\)/);
  });
});
