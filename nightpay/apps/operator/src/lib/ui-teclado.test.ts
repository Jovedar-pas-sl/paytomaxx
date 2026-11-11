import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { keyHeightPx, otroImporteHeightPx, tabBarPx } from './importe';

// Grafito 3 · punto 8: el teclado de «Otro importe» según el alto de la
// pantalla y el botón «Añadir» siempre a la vista, a 360×640 y a 390×844.

const COBRAR = readFileSync(new URL('../components/cobrar/cobrar.module.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const STAFF = readFileSync(new URL('../../../../packages/ui/src/staff.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no está ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

describe('altura de las teclas: clamp(48px, 8.5svh, 72px)', () => {
  it('el CSS dice exactamente eso (con vh de respaldo antes)', () => {
    const key = rule(COBRAR, '.key');
    expect(key).toContain('height: clamp(48px, 8.5vh, 72px);');
    expect(key).toContain('height: clamp(48px, 8.5svh, 72px);');
    expect(key.indexOf('8.5vh')).toBeLessThan(key.indexOf('8.5svh'));
  });

  it('el cálculo: 44 en un móvil bajo (hasta 700 de alto); si no, nunca menos de 48 ni más de 72', () => {
    expect(keyHeightPx(480)).toBe(44);
    expect(keyHeightPx(640)).toBe(44);
    expect(keyHeightPx(700)).toBe(44);
    expect(keyHeightPx(701)).toBeCloseTo(59.585, 3);
    expect(keyHeightPx(844)).toBeCloseTo(71.74, 2);
    expect(keyHeightPx(1200)).toBe(72);
  });

  it('el CSS baja las teclas a 44 px hasta 700 de alto (el mínimo para el dedo): el cálculo es el mismo', () => {
    const short = COBRAR.slice(COBRAR.lastIndexOf('@media (max-height: 700px) {'));
    expect(short).toMatch(/^@media \(max-height: 700px\) \{\s*\.key \{\s*height: 2\.75rem;/);
  });

  it('la letra va en proporción: 22 en las bajas y 28 desde 760 px de alto', () => {
    expect(rule(COBRAR, '.key')).toMatch(/font: 700 var\(--np-fs-22\) var\(--np-font-num\)/);
    const tall = COBRAR.slice(COBRAR.indexOf('@media (min-height: 760px) {\n  .key'));
    expect(tall).toMatch(/\.key \{\s*font-size: var\(--np-fs-28\);/);
  });

  it('el importe: 40 en las bajas, 64 en las altas', () => {
    expect(rule(COBRAR, '.amountShow .num')).toMatch(/font: 700 var\(--np-fs-40\)/);
    expect(COBRAR).toMatch(/@media \(min-height: 760px\) \{\s*\.amountShow \{[^}]*\}\s*\.amountShow \.num \{\s*font-size: var\(--np-fs-64\);/);
  });
});

describe('«Añadir X €» siempre a la vista', () => {
  it('móvil pequeño 360×640: con hasta 4 secciones todo cabe sin bajar', () => {
    expect(otroImporteHeightPx(640, 1)).toBeLessThanOrEqual(640);
  });

  it('móvil normal 390×844: cabe con las secciones en dos filas', () => {
    expect(otroImporteHeightPx(844, 2)).toBeLessThanOrEqual(844);
  });

  it('a 640 de alto cabe también con las secciones en dos filas; y si algo bajara, el pie con «Añadir» queda pegado (sticky) sobre la barra', () => {
    expect(otroImporteHeightPx(640, 2)).toBeLessThanOrEqual(640);
    const foot = rule(COBRAR, '.foot');
    expect(foot).toContain('position: sticky');
    expect(foot).toContain('bottom: var(--np-foot-bottom, 0)');
  });

  it('el cálculo de la barra de pestañas es el del CSS', () => {
    expect(STAFF).toContain('--np-tabbar-h: clamp(3.5rem, 8vh, 4.25rem)');
    expect(tabBarPx(640)).toBe(56);
    expect(tabBarPx(844)).toBeCloseTo(67.52, 2);
  });
});
