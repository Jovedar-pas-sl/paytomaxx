import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * El Resumen (entrega 9, parte B): las medidas del encargo leídas en el CSS
 * (las pruebas del panel no tienen maquetación) y las reglas de un Chrome 64.
 */

const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\r\n/g, '\n');
const CSS = strip(readFileSync(new URL('../styles/panel-resumen.css', import.meta.url), 'utf8'));
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

describe('el Resumen en CSS', () => {
  it('se carga en el panel', () => {
    expect(LAYOUT).toContain("import '../styles/panel-resumen.css';");
  });

  it('desde 1280, las cifras en una línea: «Pagado» 1,5 y las tres del mapa 1 cada una', () => {
    expect(body('.np-resumen-figs[data-map]', '@media (min-width: 1280px)')).toContain('grid-template-columns: minmax(0, 1.5fr) minmax(0, 3fr)');
    expect(body('.np-resumen-map')).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
  });

  it('hasta 640, las tres del mapa como filas de 48, sin frase', () => {
    expect(body('.np-resumen-map .np-mmq-card', '@media (max-width: 640px)')).toContain('min-height: 3rem');
    expect(body('.np-resumen-map .np-mmq-cap', '@media (max-width: 640px)')).toContain('display: none');
  });

  it('desde 1101, dos columnas (5/12 y 7/12)', () => {
    expect(body('.np-resumen-cols', '@media (min-width: 1101px)')).toContain('grid-template-columns: minmax(0, 5fr) minmax(0, 7fr)');
  });

  it('«Pide tu atención»: filas de 56 (64 en el móvil), botones de 36 (44 táctil)', () => {
    expect(body('.np-resumen-row')).toContain('min-height: 3.5rem');
    expect(body('.np-resumen-row', '@media (max-width: 640px)')).toContain('min-height: 4rem');
    expect(body('.np-resumen-row-btn')).toContain('min-height: 2.25rem');
    expect(CSS).toMatch(/@media \(max-width: 640px\), \(pointer: coarse\) \{\s*\.np-resumen-row-btn,\s*\.np-resumen-more \{\s*min-height: 2\.75rem;/);
  });

  it('el minigráfico, como mucho de 15rem', () => {
    expect(body('.np-spark')).toContain('max-width: 15rem');
  });

  it('nada que un Chrome 64 no entienda', () => {
    expect(CSS).not.toMatch(/(^|[\s;{])inset\s*:/);
    expect(CSS).not.toMatch(/\bmin\(|\bclamp\(|:has\(|color-mix\(/);
    expect(CSS).not.toMatch(/rgba\([^,)]*\)/);
    // Sin gap en flex: los huecos en flex van con márgenes.
    for (const rule of CSS.match(/[^{}]+\{[^{}]*display:\s*flex[^{}]*\}/g) ?? []) {
      expect(rule, rule).not.toMatch(/(^|[\s;{])(row-|column-)?gap\s*:/);
    }
  });
});
