import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Los grises y bordes de @nightpay/ui, dirección Grafito (2-nov-2026): si
// alguien los vuelve a bajar, esta prueba lo dice. WCAG 2.x: 4,5:1 texto, 3:1
// bordes de lo que se toca (1.4.11); para las ayudas pequeñas en oscuro se
// pide 7:1 (lo que Apple pide a los colores propios con letra pequeña).
// «Color y relieve» (25-nov-2026) cambió la paleta oscura (suelo #091518 y
// superficies más claras): los mínimos de abajo son los de esa paleta; el
// detalle, en ui-nivel-color.test.ts.

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
const ROOT = tokens(':root');

describe('grises y bordes del tema oscuro', () => {
  const t = DARK;
  // Antes: ayudas ≥ 6:1 aún sobre surface-3 y etiquetas ≥ 9:1 sobre surface-2.
  // Con las superficies nuevas (más claras) las ayudas dan 5,8:1 sobre
  // surface-3 y las etiquetas 8,4:1 sobre surface-2: la regla nueva es ayudas
  // ≥ 7:1 sobre el fondo y las tarjetas, ≥ 6:1 sobre surface-2, y nada de
  // texto pequeño «dim» sobre surface-3.
  it('textos secundarios: ayudas ≥ 7:1 sobre el fondo y las tarjetas y ≥ 6:1 sobre surface-2', () => {
    expect(contrast(t['--np-text-dim']!, t['--np-bg']!)).toBeGreaterThanOrEqual(7);
    expect(contrast(t['--np-text-dim']!, t['--np-surface']!)).toBeGreaterThanOrEqual(7);
    expect(contrast(t['--np-text-dim']!, t['--np-surface-2']!)).toBeGreaterThanOrEqual(6);
    expect(contrast(t['--np-text-mute']!, t['--np-bg']!)).toBeGreaterThanOrEqual(10);
    expect(contrast(t['--np-text-label']!, t['--np-surface-2']!)).toBeGreaterThanOrEqual(8);
  });

  it('tres niveles de texto que se distinguen entre sí', () => {
    // Antes pedía 4 puntos entre el texto y el secundario; la crema nueva deja 3,9.
    expect(contrast(t['--np-text']!, t['--np-bg']!)).toBeGreaterThan(contrast(t['--np-text-mute']!, t['--np-bg']!) + 3.5);
    expect(contrast(t['--np-text-mute']!, t['--np-bg']!)).toBeGreaterThan(contrast(t['--np-text-dim']!, t['--np-bg']!) + 2);
  });

  it('el borde de lo que se toca se ve: ≥ 3:1 sobre el fondo y las superficies', () => {
    for (const bg of ['--np-bg', '--np-surface', '--np-surface-2', '--np-surface-3']) {
      expect(contrast(t['--np-border-hi']!, t[bg]!), bg).toBeGreaterThanOrEqual(3);
    }
  });

  it('el rojo de los errores pequeños se lee (≥ 7:1)', () => {
    expect(contrast(t['--np-danger-text']!, t['--np-bg']!)).toBeGreaterThanOrEqual(7);
    expect(contrast(t['--np-danger-text']!, t['--np-surface']!)).toBeGreaterThanOrEqual(7);
  });

  it('la lima lleva tinta encima (≥ 11:1)', () => {
    // El acento apunta a la lima de la marca (--np-lime), para que le llegue la de las pantallas P3.
    expect(STYLES).toMatch(/--np-accent: var\(--np-lime\);/);
    expect(contrast(t['--np-on-accent']!, ROOT['--np-lime']!)).toBeGreaterThanOrEqual(11);
  });
});

describe('resultados: colores planos y profundos con texto crema', () => {
  it('PAGADO ≥ 10:1, NO PAGADO ≥ 9:1 y CADUCADO ≥ 8:1', () => {
    expect(contrast(ROOT['--np-outcome-ink']!, ROOT['--np-outcome-paid']!)).toBeGreaterThanOrEqual(10);
    expect(contrast(ROOT['--np-outcome-ink']!, ROOT['--np-outcome-failed']!)).toBeGreaterThanOrEqual(9);
    expect(contrast(ROOT['--np-outcome-ink']!, ROOT['--np-outcome-expired']!)).toBeGreaterThanOrEqual(8);
  });

  // Antes también pedía el botón principal plano (--np-primary-shadow: none).
  // El dueño eligió botones con relieve (idea 3): ahora lleva brillo y sombra,
  // y es la única sombra de color; los resultados siguen planos.
  it('sin halos sueltos ni textura 0101; los resultados, planos; el relieve es el del botón principal', () => {
    expect(STYLES).toMatch(/--np-lime-glow: transparent;/);
    expect(STYLES).toMatch(/--np-bits: none;/);
    expect(STYLES).toMatch(/--np-primary-shadow: inset 0 1px 0 rgba\(255, 255, 255, 0\.45\)/);
    expect(STYLES).not.toMatch(/--np-outcome-(paid|failed|expired): [a-z-]*gradient/);
  });
});

describe('grises y bordes del tema claro (solo el panel)', () => {
  const t = LIGHT;
  it('ayudas ≥ 5:1 sobre el papel y sobre surface-2', () => {
    expect(contrast(t['--np-text-dim']!, t['--np-bg']!)).toBeGreaterThanOrEqual(5);
    expect(contrast(t['--np-text-dim']!, t['--np-surface-2']!)).toBeGreaterThanOrEqual(5);
    expect(contrast(t['--np-success']!, t['--np-bg']!)).toBeGreaterThanOrEqual(6);
    expect(contrast(t['--np-danger-text']!, t['--np-bg']!)).toBeGreaterThanOrEqual(4.5);
  });

  it('el borde de lo que se toca se ve: ≥ 3:1 sobre el papel y las superficies', () => {
    for (const bg of ['--np-bg', '--np-surface', '--np-surface-2']) {
      expect(contrast(t['--np-border-hi']!, t[bg]!), bg).toBeGreaterThanOrEqual(3);
    }
  });

  // El mismo filete, escrito rgba(r, g, b, a) («Color y relieve»: así lo entiende el Chrome 64 de los datáfonos).
  it('la lima lleva filete de tinta (no se funde con el papel)', () => {
    expect(STYLES).toMatch(/--np-primary-shadow: inset 0 0 0 1px rgba\(21, 25, 28, 0\.7\)/);
  });
});

describe('botón sin nada que hacer', () => {
  it('superficie y texto apagado, sin opacidad ni lima apagada (y no mientras carga)', () => {
    const rule = /\.np-btn:disabled:not\(\[data-loading\]\) \{([^}]*)\}/.exec(STYLES)?.[1] ?? '';
    expect(rule).toContain('background: var(--np-disabled-bg)');
    expect(rule).toContain('color: var(--np-disabled-ink)');
    expect(rule).not.toContain('opacity');
    // El texto del botón vacío se lee en los dos temas.
    expect(contrast(DARK['--np-text-dim']!, DARK['--np-surface-2']!)).toBeGreaterThanOrEqual(6.5);
    expect(contrast(LIGHT['--np-text-dim']!, LIGHT['--np-surface-2']!)).toBeGreaterThanOrEqual(5);
  });
});
