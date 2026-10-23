import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// El PAGADO de @nightpay/ui (staff.css y PaymentOutcome): el código corto
// grande y la referencia pequeña (D7), y el momento PAGADO una sola vez (D10),
// que con «reducir movimiento» se queda en el estado final.

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const STAFF = read('../../../../packages/ui/src/staff.css');
const STYLES = read('../../../../packages/ui/src/styles.css');
const OUTCOME = read('../../../../packages/ui/src/components/PaymentOutcome.tsx');

/** El cuerpo de la primera regla con ese selector exacto. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no está ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

const rem = (body: string, prop: string): number => Number(new RegExp(`${prop}:\\s*([\\d.]+)rem`).exec(body)?.[1] ?? NaN);

describe('D7: el código grande y la referencia pequeña', () => {
  it('el código se lee a un metro (≥ 3rem) y la referencia va por debajo de 1rem', () => {
    expect(rem(rule(STAFF, '.np-outcome-code-value'), 'font-size')).toBeGreaterThanOrEqual(3);
    expect(rem(rule(STAFF, '.np-outcome-ref'), 'font-size')).toBeLessThan(1);
  });

  it('en el PAGADO, el código va justo después del importe y la propina, antes del detalle', () => {
    const summary = OUTCOME.indexOf('{summary ?');
    const code = OUTCOME.indexOf('np-outcome-code"');
    const detail = OUTCOME.indexOf('{detail ?');
    expect(summary).toBeGreaterThan(0);
    expect(code).toBeGreaterThan(summary);
    expect(detail).toBeGreaterThan(code);
  });
});

describe('D10: el momento PAGADO, una vez', () => {
  it('un destello verde de la pantalla, una sola vez y sin bloquear los toques', () => {
    const flash = rule(STAFF, ".np-outcome[data-kind='paid']::after");
    expect(flash).toContain('pointer-events: none');
    expect(flash).toMatch(/animation: np-outcome-flash var\(--np-d-moment\) ease-out 1 both/);
    expect(STYLES).toMatch(/--np-d-moment: 420ms;/);
    // Sube y baja: nunca más de un destello (WCAG 2.3.1: menos de 3 por segundo).
    expect(STAFF).toMatch(/@keyframes np-outcome-flash \{\s*0%\s+\{ opacity: 0;\s*\}\s*30%\s+\{ opacity: 0\.55;\s*\}\s*100%\s+\{ opacity: 0;\s*\}/);
  });

  it('el aro salta y la marca se dibuja (y queda dibujada)', () => {
    expect(STAFF).toMatch(/\.np-outcome\[data-kind='paid'\] \.np-outcome-ring \{\s*animation: np-outcome-pop var\(--np-d-moment\) var\(--np-ease-pop\) 1 both;/);
    const path = rule(STAFF, ".np-outcome[data-kind='paid'] .np-outcome-icon path");
    expect(path).toContain('stroke-dashoffset: 0');
    expect(OUTCOME).toContain('pathLength={1}');
  });

  it('con «reducir movimiento»: sin destello ni animación, solo el estado final', () => {
    const reduce = STAFF.slice(STAFF.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduce).toMatch(/\.np-outcome\[data-kind='paid'\]::after \{\s*display: none;/);
    expect(reduce).toMatch(/\.np-outcome\[data-kind='paid'\] \.np-outcome-ring,\s*\.np-outcome\[data-kind='paid'\] \.np-outcome-icon path \{\s*animation: none !important;/);
  });
});
