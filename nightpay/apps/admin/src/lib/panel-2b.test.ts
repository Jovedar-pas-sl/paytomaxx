import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { navSearch } from './nav-url';

/**
 * Panel II, parte B (entrega 10): el selector de noches y Ctrl+K. Las medidas
 * del encargo leídas en el CSS y en el código, y las reglas de un Chrome 64.
 */

const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\r\n/g, '\n');
const CSS = strip(readFileSync(new URL('../styles/panel-2.css', import.meta.url), 'utf8'));
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const B_CSS = CSS.slice(CSS.indexOf('.np-noches'));

describe('Panel II (B) en CSS', () => {
  it('el selector: botón de 40 (44 en móvil), filas de 48 y línea de 14', () => {
    expect(B_CSS).toMatch(/\.np-noches-btn \{[^}]*min-height: 40px/);
    expect(B_CSS).toMatch(/@media \(max-width: 640px\) \{[^@]*\.np-noches-btn \{[^}]*min-height: 44px/);
    expect(B_CSS).toMatch(/\.np-noches-item \{[^}]*min-height: 48px/);
    expect(B_CSS).toMatch(/\.np-noches-line \{[^}]*font-size: 14px/);
  });

  it('el buscador: caja de 35rem, campo a 16 y filas de 48', () => {
    expect(read('../components/CommandPalette.tsx')).toContain('width="35rem"');
    expect(B_CSS).toMatch(/\.np-cmdk-input \{[^}]*font-size: 16px/);
    expect(B_CSS).toMatch(/\.np-cmdk-option \{[^}]*min-height: 48px/);
  });

  it('nada que un Chrome 64 no entienda', () => {
    expect(B_CSS).not.toMatch(/\binset\s*:|(^|[\s;{])gap\s*:|\bmin\(|\bclamp\(|:has\(|color-mix\(|rgba\(\s*\d+\s+\d+/);
  });
});

describe('el selector en las pantallas', () => {
  it('el mapa: el selector con la marca del tutorial; sin la caja de fechas de antes', () => {
    const map = read('../components/money-map/MoneyMapPanel.tsx');
    expect(map).toContain('<SelectorNoches');
    expect(map).toContain('data-tour="mapa-fechas"');
    expect(map).not.toContain('np-mm-period-box');
    expect(read('./tours.ts')).toContain("text: 'Por defecto sale esta noche. Toca el botón para ver otra noche o unas fechas.'");
  });

  it('Cobros: el selector en vez de «Noche ▾», sin nightId', () => {
    const bar = read('../components/CobrosToolbar.tsx');
    expect(bar).toContain('<SelectorNoches');
    expect(bar).not.toContain('nightId');
    expect(read('../components/PaymentsPanel.tsx')).toContain('Buscando en todas las fechas');
  });

  it('Informes: los periodos del calendario, por días naturales', () => {
    const rep = read('../components/ReportsPanel.tsx');
    expect(rep).toContain('<SelectorNoches');
    expect(rep).toContain('Los informes van por días naturales, como los pide la gestoría');
  });

  it('cambiar de pestaña quita ?fechas=; seguir en la misma, no', () => {
    expect(navSearch('?s=hoy&t=mapa&fechas=finde', 'payments')).toBe('?s=hoy&t=cobros');
    expect(navSearch('?s=hoy&t=mapa&fechas=finde', 'money')).toBe('?s=hoy&t=mapa&fechas=finde');
    expect(navSearch('?s=hoy&t=mapa&fechas=finde', 'resumen')).toBe('');
  });
});
