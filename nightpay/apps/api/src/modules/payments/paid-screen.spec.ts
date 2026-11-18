import { describe, it, expect } from 'vitest';
import { PAID_CLOSE_MS, PAID_FRESH_MS, PAID_SCREEN_CSS, PAID_SCREEN_JS, formatAgo, renderPaidScreen } from './paid-screen';
import { PAY_TEXT } from './pay-i18n';

const es = PAY_TEXT.es;
const en = PAY_TEXT.en;
const fr = PAY_TEXT.fr;
const pt = PAY_TEXT.pt;

/** El npAgo del navegador, sacado del JS de la página. */
const npAgo = new Function(`${PAID_SCREEN_JS}; return npAgo;`)() as (
  ms: number,
  t: { agoPrefix: string; agoSuffix: string; agoUnits: { min: string; h: string; d: string } },
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

  it('en francés y portugués, con sus unidades (« j » de jours)', () => {
    expect(formatAgo(12_000, fr)).toBe('il y a 0:12');
    expect(formatAgo(65 * 60_000, fr)).toBe('il y a 1 h 05 min');
    expect(formatAgo(50 * 3_600_000, fr)).toBe('il y a 2 j');
    expect(formatAgo(12_000, pt)).toBe('há 0:12');
    expect(formatAgo(23 * 60_000, pt)).toBe('há 23 min');
    expect(formatAgo(50 * 3_600_000, pt)).toBe('há 2 d');
  });

  it('el JS del navegador dice lo mismo que el HTML del servidor', () => {
    for (const ms of [0, 12_000, 599_000, 600_000, 23 * 60_000, 65 * 60_000, 50 * 3_600_000]) {
      for (const t of [es, en, fr, pt]) expect(npAgo(ms, t)).toBe(formatAgo(ms, t));
    }
  });
});

describe('pantalla «Pagado»', () => {
  const at = new Date('2026-10-15T22:00:00Z');
  const base = { t: es, amount: '65,00 €', authorizedAt: at, code: 'A6B' };

  it('recién pagado → lima («Pagado»); pasado el margen → gris («Ya pagado», «No es un pago nuevo»)', () => {
    const fresh = renderPaidScreen({ ...base, viewerPaid: true, now: new Date(at.getTime() + PAID_FRESH_MS - 1) });
    expect(fresh).toContain('class="paid" id="paid"');
    expect(fresh).toContain('>Pagado</h1>');
    const stale = renderPaidScreen({ ...base, viewerPaid: true, now: new Date(at.getTime() + PAID_FRESH_MS) });
    expect(stale).toContain('class="paid stale" id="paid"');
    expect(stale).toContain('>Ya pagado</h1>');
    expect(stale).toContain('No es un pago nuevo.');
  });

  it('otro navegador (no el que pagó) → gris aunque sea de hace un segundo', () => {
    const html = renderPaidScreen({ ...base, now: new Date(at.getTime() + 1_000) });
    expect(html).toContain('class="paid stale" id="paid"');
    expect(html).toContain('>Ya pagado</h1>');
    expect(renderPaidScreen({ ...base, viewerPaid: false, now: at })).toContain('class="paid stale"');
  });

  it('a los 5 min se cierra (también al recargar): solo «Pago terminado» y el justificante; el JS lo hace a la vista', () => {
    const footer = '<a class="link" href="/r/x">Ver el justificante</a>';
    const open = renderPaidScreen({ ...base, footer, viewerPaid: true, now: new Date(at.getTime() + PAID_CLOSE_MS - 1) });
    expect(open).toContain('class="paid stale" id="paid"');
    const closed = renderPaidScreen({ ...base, footer, viewerPaid: true, now: new Date(at.getTime() + PAID_CLOSE_MS) });
    expect(closed).toContain('class="paid stale closed" id="paid"');
    expect(closed).toContain('<p class="pthanks" role="status">Pago terminado. ¡Gracias!</p>');
    expect(closed).toContain(footer);
    expect(PAID_SCREEN_CSS).toContain('.paid.closed>:not(.pthanks):not(.pfoot){display:none}');
    expect(PAID_SCREEN_JS).toContain("el.classList.add('closed')");
    // Sin hora de autorización no se sabe cuándo cerrar: no se cierra.
    expect(renderPaidScreen({ ...base, authorizedAt: null, now: new Date(at.getTime() + PAID_CLOSE_MS) })).not.toContain(' closed"');
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
