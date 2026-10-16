import { describe, it, expect } from 'vitest';
import { PAID_FRESH_MS, PAID_SCREEN_JS, formatAgo, renderPaidScreen } from './paid-screen';
import { PAY_TEXT } from './pay-i18n';

const es = PAY_TEXT.es;
const en = PAY_TEXT.en;

/** El npAgo del navegador, sacado del JS de la página. */
const npAgo = new Function(`${PAID_SCREEN_JS}; return npAgo;`)() as (
  ms: number,
  t: { agoPrefix: string; agoSuffix: string },
) => string;

describe('«hace 0:12» / «hace 23 min»', () => {
  it('minutos:segundos los primeros 10 min; luego minutos, horas y días', () => {
    expect(formatAgo(12_000, es)).toBe('hace 0:12');
    expect(formatAgo(9 * 60_000 + 59_000, es)).toBe('hace 9:59');
    expect(formatAgo(23 * 60_000, es)).toBe('hace 23 min');
    expect(formatAgo(65 * 60_000, es)).toBe('hace 1 h 05 min');
    expect(formatAgo(50 * 3_600_000, es)).toBe('hace 2 d');
    expect(formatAgo(12_000, en)).toBe('0:12 ago');
    expect(formatAgo(-5_000, es)).toBe('hace 0:00');
  });

  it('el JS del navegador dice lo mismo que el HTML del servidor', () => {
    for (const ms of [0, 12_000, 599_000, 600_000, 23 * 60_000, 65 * 60_000, 50 * 3_600_000]) {
      expect(npAgo(ms, es)).toBe(formatAgo(ms, es));
      expect(npAgo(ms, en)).toBe(formatAgo(ms, en));
    }
  });
});

describe('pantalla «Pagado»', () => {
  const at = new Date('2026-10-15T22:00:00Z');
  const base = { t: es, amount: '65,00 €', authorizedAt: at, code: 'A6B' };

  it('recién pagado → lima («Pagado»); pasado el margen → gris («Ya pagado», «No es un pago nuevo»)', () => {
    const fresh = renderPaidScreen({ ...base, now: new Date(at.getTime() + PAID_FRESH_MS - 1) });
    expect(fresh).toContain('class="paid" id="paid"');
    expect(fresh).toContain('>Pagado</h1>');
    const stale = renderPaidScreen({ ...base, now: new Date(at.getTime() + PAID_FRESH_MS) });
    expect(stale).toContain('class="paid stale" id="paid"');
    expect(stale).toContain('>Ya pagado</h1>');
    expect(stale).toContain('No es un pago nuevo.');
  });

  it('sin hora de autorización no puede pasar por nuevo', () => {
    const html = renderPaidScreen({ ...base, authorizedAt: null, now: at });
    expect(html).toContain('class="paid stale"');
    expect(html).toContain('data-at=""');
  });

  it('el estado no lo dice solo el color: texto, franja que se mueve y alternativa sin movimiento', () => {
    const html = renderPaidScreen({ ...base, now: at, lines: ['<b>no HTML</b>'] });
    expect(html).toContain('&lt;b&gt;no HTML&lt;/b&gt;');
    expect(html).toContain('class="band" aria-hidden="true"');
    expect(html).toContain(`data-fresh="${PAID_FRESH_MS}"`);
  });

  it('JS sin barras invertidas (va dentro de una plantilla de TypeScript)', () => {
    expect(PAID_SCREEN_JS).not.toContain('\\');
  });
});
