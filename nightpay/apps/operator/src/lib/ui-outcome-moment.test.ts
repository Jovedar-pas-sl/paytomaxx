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

const rem = (body: string, prop: string): number => {
  const token = new RegExp(`${prop}:\\s*var\\(--np-fs-(\\d+)\\)`).exec(body)?.[1];
  if (token) return Number(token) / 16;
  return Number(new RegExp(`${prop}:\\s*([\\d.]+)rem`).exec(body)?.[1] ?? NaN);
};

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

  it('una sola marca de hecho: disco lima con ✓ de tinta que salta y se dibuja, sin aro verde', () => {
    const done = rule(STAFF, '.np-done');
    expect(done).toMatch(/background: var\(--np-lime\)/);
    expect(done).toMatch(/color: var\(--np-ink\)/);
    expect(done).toMatch(/animation: np-done-pop var\(--np-d-moment\) var\(--np-ease-pop\) 1 both;/);
    expect(done).not.toMatch(/box-shadow|filter/);
    expect(rule(STAFF, '.np-done path')).toMatch(/animation: np-done-draw var\(--np-d-moment\) var\(--np-ease\) 120ms 1 both/);
    expect(read('../../../../packages/ui/src/components/DoneMark.tsx')).toContain('pathLength={1}');
    expect(OUTCOME).toContain('<DoneMark />');
    expect(STAFF).not.toContain('np-check');
    expect(STYLES).not.toContain('outcome-tick-ring');
  });

  it('PAGADO, CARGADO, su banda y la pantalla del cliente usan la misma marca', () => {
    expect(read('../components/reception/desk/DeskLoaded.tsx').match(/<DoneMark/g)).toHaveLength(2);
    expect(read('../components/pantalla/PantallaCliente.tsx')).toContain('<DoneMark');
  });

  it('con «reducir movimiento»: sin destello ni animación, solo el estado final', () => {
    const reduce = STAFF.slice(STAFF.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduce).toMatch(/\.np-outcome\[data-kind='paid'\]::after \{\s*display: none;/);
    expect(reduce).toMatch(/\.np-done,\s*\.np-done path \{\s*animation: none !important;\s*stroke-dashoffset: 0;/);
  });
});

describe('Esperando con «reducir movimiento»: nada en bucle', () => {
  const COBRAR = read('../components/cobrar/cobrar.module.css');
  const reduce = (() => {
    const at = COBRAR.indexOf('@media (prefers-reduced-motion: reduce)');
    return COBRAR.slice(at, COBRAR.indexOf('\n}\n', at));
  })();

  // Grafito: sin la tarjeta plata ni su halo; la única señal de espera es el punto.
  it('el punto de «Esperando el pago…», quieto y a la vista', () => {
    expect(reduce).toMatch(/\.live i \{[^}]*animation: none !important;/);
    expect(reduce).not.toContain('infinite');
    expect(reduce).not.toMatch(/opacity: 0[;.]/);
  });
});
