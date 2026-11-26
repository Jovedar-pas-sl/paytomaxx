import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SALA_ATTR, SALA_INIT_SCRIPT, SALA_STORAGE_KEY, applySalaContrast } from './sala-contrast';

function fakeRoot() {
  const attrs = new Map<string, string>();
  return {
    attrs,
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    removeAttribute: (k: string) => void attrs.delete(k),
  };
}

function fakeStorage() {
  const items = new Map<string, string>();
  return {
    items,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
    getItem: (k: string) => items.get(k) ?? null,
  };
}

describe('modo «sala» en la app del personal (decisión D9)', () => {
  it('encendido: <html data-contrast="sala"> y este móvil lo recuerda', () => {
    const root = fakeRoot();
    const storage = fakeStorage();
    applySalaContrast(root, storage, true);
    expect(root.attrs.get(SALA_ATTR)).toBe('sala');
    expect(storage.items.get(SALA_STORAGE_KEY)).toBe('sala');
  });

  it('apagado: se quita y se olvida', () => {
    const root = fakeRoot();
    const storage = fakeStorage();
    applySalaContrast(root, storage, true);
    applySalaContrast(root, storage, false);
    expect(root.attrs.has(SALA_ATTR)).toBe(false);
    expect(storage.items.has(SALA_STORAGE_KEY)).toBe(false);
  });

  it('sin almacenamiento (navegación privada) se aplica igual', () => {
    const root = fakeRoot();
    const broken = {
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
      removeItem: () => undefined,
    };
    expect(() => applySalaContrast(root, broken, true)).not.toThrow();
    expect(root.attrs.get(SALA_ATTR)).toBe('sala');
    applySalaContrast(root, null, false);
    expect(root.attrs.has(SALA_ATTR)).toBe(false);
  });

  it('el script del layout lo pone antes de pintar si este móvil lo recuerda', () => {
    const run = (stored: string | null) => {
      const root = fakeRoot();
      const storage = fakeStorage();
      if (stored) storage.setItem(SALA_STORAGE_KEY, stored);
      new Function('localStorage', 'document', SALA_INIT_SCRIPT)(storage, { documentElement: root });
      return root.attrs.get(SALA_ATTR) ?? null;
    };
    expect(run('sala')).toBe('sala');
    expect(run(null)).toBeNull();
    expect(run('otra')).toBeNull();
    expect(SALA_INIT_SCRIPT.includes(String.fromCharCode(92))).toBe(false);
    const layout = readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8');
    expect(layout).toContain('SALA_INIT_SCRIPT');
  });

  it('las fichas de contraste alto existen en @nightpay/ui (oscuro y claro) y suben la letra un paso', () => {
    const css = readFileSync(new URL('../../../../packages/ui/src/styles.css', import.meta.url), 'utf8');
    expect(css).toMatch(/html\[data-contrast='sala'\] \{/);
    expect(css).toMatch(/html\[data-theme='light'\]\[data-contrast='sala'\] \{/);
    expect(css).toMatch(/html\.np-staff\[data-contrast='sala'\] \{\s*font-size: 106\.25%;/);
  });

  // «Color y relieve» (25-nov-2026): las superficies oscuras son más claras que
  // las de Grafito, así que los valores del modo «sala» se recalcularon. Aquí
  // se mide que siguen cumpliendo: más contraste que el modo normal en todo.
  describe('contraste del modo «sala» sobre las superficies nuevas (oscuro)', () => {
    const css = readFileSync(new URL('../../../../packages/ui/src/styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const hexes = (selector: string): Record<string, string> => {
      const start = css.indexOf(`${selector} {`);
      if (start < 0) throw new Error(`no está el bloque ${selector}`);
      const out: Record<string, string> = {};
      for (const m of css.slice(start, css.indexOf('\n}', start)).matchAll(/(--np-[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]!] = m[2]!.toLowerCase();
      return out;
    };
    const dark = hexes(":root,\n[data-theme='dark']");
    const sala = hexes("html[data-contrast='sala']");
    const contrast = (a: string, b: string): number => {
      const lum = (hex: string): number => {
        const [r, g, bl] = [1, 3, 5].map((i) => {
          const c = parseInt(hex.slice(i, i + 2), 16) / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        }) as [number, number, number];
        return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
      };
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };

    it('el texto secundario y las etiquetas: ≥ 10:1 sobre lo elevado (surface-2)', () => {
      expect(contrast(sala['--np-text-mute']!, dark['--np-surface-2']!)).toBeGreaterThanOrEqual(10);
      expect(contrast(sala['--np-text-label']!, dark['--np-surface-2']!)).toBeGreaterThanOrEqual(10);
    });

    it('las ayudas: ≥ 7:1 aún sobre lo pulsado (surface-3), donde el modo normal no llega a 6', () => {
      expect(contrast(sala['--np-text-dim']!, dark['--np-surface-3']!)).toBeGreaterThanOrEqual(7);
      expect(contrast(dark['--np-text-dim']!, dark['--np-surface-3']!)).toBeLessThan(6);
    });

    it('los botones secundarios se ven sin buscar: filete ≥ 6:1 sobre el fondo, las tarjetas y lo elevado', () => {
      for (const bg of ['--np-bg', '--np-surface', '--np-surface-2']) {
        expect(contrast(sala['--np-border-hi']!, dark[bg]!), bg).toBeGreaterThanOrEqual(6);
      }
    });

    it('los separadores, más marcados: ≥ 2,5:1 sobre las tarjetas (en el modo normal, 1,4)', () => {
      expect(contrast(sala['--np-border']!, dark['--np-surface']!)).toBeGreaterThanOrEqual(2.5);
    });

    it('el borde de las tarjetas también se marca: sigue al separador, ≥ 3:1 sobre el suelo (en el modo normal, crema al 7 %, unos 1,5)', () => {
      const start = css.indexOf("html[data-contrast='sala'] {");
      expect(css.slice(start, css.indexOf('\n}', start))).toMatch(/--np-card-edge: var\(--np-border\);/);
      expect(contrast(sala['--np-border']!, dark['--np-bg']!)).toBeGreaterThanOrEqual(3);
    });

    it('todo sube respecto al modo normal, y ninguno pasa del texto principal', () => {
      for (const name of ['--np-text-mute', '--np-text-dim', '--np-text-label', '--np-border', '--np-border-hi']) {
        expect(contrast(sala[name]!, dark['--np-surface']!), name).toBeGreaterThan(contrast(dark[name]!, dark['--np-surface']!));
      }
      for (const name of ['--np-text-mute', '--np-text-dim', '--np-text-label']) {
        expect(contrast(sala[name]!, dark['--np-bg']!), name).toBeLessThan(contrast(dark['--np-text']!, dark['--np-bg']!));
      }
    });
  });
});
