import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Panel II, parte A (entrega 10): Ajustes como lista, el cierre plegado,
 * Primeros pasos, «Cerrar noche» en Resumen y la cabecera. Las medidas del
 * encargo leídas en el CSS y las reglas de un Chrome 64.
 */

const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\r\n/g, '\n');
const CSS = strip(readFileSync(new URL('../styles/panel-2.css', import.meta.url), 'utf8'));
const LAYOUT = readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8');

/** El cuerpo de la regla con ese selector dentro de esa @media (o fuera de todas). */
function body(selector: string, media: string | null = null): string {
  const scopes =
    media === null ? [CSS.replace(/@media[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '')] : CSS.split(`${media} {`).slice(1).map((chunk) => chunk.split('@media')[0]!);
  for (const scope of scopes) {
    const at = scope.indexOf(`${selector} {`);
    if (at >= 0) return scope.slice(at, scope.indexOf('}', at));
  }
  throw new Error(`no está ${selector}${media ? ` en ${media}` : ''}`);
}

describe('Panel II (A) en CSS', () => {
  it('se carga en el panel', () => {
    expect(LAYOUT).toContain("import '../styles/panel-2.css';");
  });

  it('Ajustes: filas de 56; desde 900, la lista de 240 a la izquierda y la activa en surface-2', () => {
    expect(body('.np-setnav-row')).toContain('min-height: 3.5rem');
    expect(body('.np-setnav-name')).toContain('font-size: 1rem');
    expect(body('.np-setnav-name')).toContain('font-weight: 600');
    expect(body('.np-setnav-hint')).toContain('font-size: 0.875rem');
    expect(body('.np-settings', '@media (min-width: 900px)')).toContain('grid-template-columns: 15rem minmax(0, 1fr)');
    expect(body(".np-setnav-row[aria-current='page']", '@media (min-width: 900px)')).toContain('background: var(--np-surface-2)');
    expect(body('.np-settings-back')).toContain('min-height: 3rem');
  });

  it('por debajo de 900, la lista o la pantalla, nunca las dos', () => {
    expect(body(".np-settings[data-view='list'] .np-settings-page", '@media (max-width: 899px)')).toContain('display: none');
    expect(body(".np-settings[data-view='page'] .np-setnav", '@media (max-width: 899px)')).toContain('display: none');
    expect(body('.np-settings-back', '@media (min-width: 900px)')).toContain('display: none');
  });

  it('el cierre: la fila de un paso listo, de 48', () => {
    expect(body('.np-close-fold')).toContain('min-height: 3rem');
  });

  it('Primeros pasos: filas de 48; «Ir» de 36 (44 en el móvil)', () => {
    expect(body('.np-pasos-row')).toContain('min-height: 3rem');
    expect(body('.np-pasos-go')).toContain('min-height: 2.25rem');
    expect(body('.np-pasos-go', '@media (max-width: 640px)')).toContain('min-height: 2.75rem');
  });

  it('«Cerrar noche» en Resumen: 40 (48 en el móvil)', () => {
    expect(body('.np-tonight-close')).toContain('min-height: 2.5rem');
    expect(body('.np-tonight-close', '@media (max-width: 640px)')).toContain('min-height: 3rem');
  });

  it('la cabecera a 360: el nombre del local, como mucho en dos líneas', () => {
    expect(body('.np-brand-name', '@media (max-width: 640px)')).toContain('-webkit-line-clamp: 2');
  });

  it('nada que un Chrome 64 no entienda', () => {
    expect(CSS).not.toMatch(/(^|[\s;{])inset\s*:/);
    expect(CSS).not.toMatch(/\bmin\(|\bclamp\(|:has\(|color-mix\(/);
    expect(CSS).not.toMatch(/rgba\([^,)]*\)/);
    expect(CSS).not.toMatch(/var\([^)]*env\(/);
    for (const rule of CSS.match(/[^{}]+\{[^{}]*display:\s*flex[^{}]*\}/g) ?? []) {
      expect(rule, rule).not.toMatch(/(^|[\s;{])(row-|column-)?gap\s*:/);
    }
  });
});
