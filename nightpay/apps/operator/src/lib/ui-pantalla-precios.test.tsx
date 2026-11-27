// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Paid, Waiting } from '../components/pantalla/PantallaCliente';
import { useTabletFicha } from '../components/pantalla/use-tablet-ficha';
import type { WaitingView } from './pantalla-state';

// Idea 70, la tablet del cliente: con «Comisión del servicio» y ficha, dos
// precios igual de grandes (con saldo y con tarjeta) y la comisión con su
// importe antes de elegir; todo con su inglés debajo; el «Pagado» con lo
// pagado; y los errores que se quedan hasta la siguiente ficha, toque o cobro.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const CSS = read('../components/pantalla/pantalla.module.css');
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/ /g, ' ').trim();

/** El cuerpo de la primera regla con ese selector exacto (desde `from`). */
function rule(css: string, selector: string, from = 0): string {
  const start = css.indexOf(`${selector} {`, from);
  if (start < 0) throw new Error(`no está ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

function view(over: Partial<WaitingView> = {}): WaitingView {
  return {
    venueName: 'Sala Luna',
    fichas: true,
    message: { line1: null, line2: null },
    pairedUntil: '2026-11-18T11:00:00.000Z',
    state: 'waiting',
    key: 'k1',
    currency: 'EUR',
    amountCents: 3300,
    totalCents: 3300,
    cardAmountCents: 3630,
    qrUrl: 'https://api.oxio.test/pay/tok',
    tip: { presets: [{ cents: 300, percent: null }, { cents: 500, percent: 15 }], maxCents: 3300, chosenCents: 0, toStaff: true },
    pinKeypad: 'fixed',
    noPinMaxCents: 2000,
    ficha: true,
    paying: false,
    topUp: false,
    ...over,
  };
}

const waiting = (v: WaitingView, problem: string | null = null): string =>
  renderToStaticMarkup(<Waiting view={v} nfcHere={false} reading={false} tipBusy={false} onTip={() => undefined} problem={problem} />);

/** Los bloques de precio: [etiqueta, importe]. */
function blocks(html: string): string[] {
  return [...html.matchAll(/<div class="_priceBlock_[^"]*">(.*?)<\/div>/g)].map((m) => text(m[1]!));
}

describe('tablet: dos precios igual de grandes', () => {
  it('con comisión y ficha: «Con saldo» y «Con tarjeta», cada uno con su inglés y su importe', () => {
    const html = waiting(view());
    expect(blocks(html)).toEqual(['Con saldo With balance 33 €', 'Con tarjeta By card 36,30 €']);
    // El mismo tamaño: la misma clase y la pieza Importe.
    expect(html.match(/<span class="np-importe _price_[^"]*">/g)).toHaveLength(2);
    expect(text(html)).toContain('Incluye 3,30 € de comisión del servicio Includes a €3.30 service fee');
    // Sin palabras de descuento ni la línea pequeña de antes.
    expect(text(html)).not.toMatch(/descuento|ahorra|discount|save|Con tarjeta, 36/i);
  });

  it('con la propina elegida, los dos la llevan (la comisión, solo sobre lo vendido)', () => {
    const html = waiting(view({ totalCents: 3800, cardAmountCents: 4130, tip: { ...view().tip!, chosenCents: 500 } }));
    expect(blocks(html)).toEqual(['Con saldo With balance 38 €', 'Con tarjeta By card 41,30 €']);
    expect(text(html)).toContain('Incluye 3,30 € de comisión del servicio');
  });

  it('sin saldo en el cobro (no hay ficha): solo la tarjeta y la nota', () => {
    const html = waiting(view({ ficha: false }));
    expect(blocks(html)).toEqual(['Con tarjeta By card 36,30 €']);
    expect(text(html)).toContain('Incluye 3,30 € de comisión del servicio');
  });

  it('sin comisión: un solo importe, como siempre', () => {
    const html = waiting(view({ cardAmountCents: null }));
    expect(blocks(html)).toEqual([]);
    expect(text(html)).toContain('Total 33 €');
    expect(text(html)).not.toContain('comisión');
  });

  it('el importe: grande y creciendo con la pantalla (clamp con respaldo); lado a lado solo en vertical y desde 35em', () => {
    const price = rule(CSS, '.price');
    // El encargo decía 3rem; la escala de Grafito 3 (ui-escala) solo deja sus tamaños: 40 px como mínimo.
    expect(price).toMatch(/font-size: var\(--np-fs-40\);\s*font-size: clamp\(var\(--np-fs-40\), 11vmin, 20vmin\);/);
    // Apilados por defecto (apaisado: el QR deja ~490 px; y en 360).
    expect(rule(CSS, '.prices')).toMatch(/flex-direction: column;/);
    const side = CSS.indexOf('@media (min-width: 35em) and (max-aspect-ratio: 5/4) {');
    expect(side).toBeGreaterThan(0);
    expect(rule(CSS, '.prices', side)).toMatch(/flex-direction: row;/);
    expect(rule(CSS, '.priceBlock', side)).toMatch(/flex: 1 1 0(px|%)?;/);
    // Chrome 64: sin gap en flex.
    expect(rule(CSS, '.prices')).not.toMatch(/\bgap:/);
  });
});

describe('tablet: propinas con el total, y a quién van', () => {
  it('un precio: «+3 €» y debajo el total con ella; «Sin propina» con el total; sin «%»', () => {
    const html = waiting(view({ cardAmountCents: null }));
    expect(html).toContain('aria-label="Propina de 3 €. Total 36 €"');
    expect(html).toContain('aria-label="Sin propina. Total 33 €"');
    expect(text(html)).toContain('+3 € 36 €');
    expect(text(html)).not.toContain('%');
  });

  it('solo tarjeta con comisión: la base es su precio sin la propina elegida', () => {
    const html = waiting(view({ ficha: false, totalCents: 3600, cardAmountCents: 3930, tip: { ...view().tip!, chosenCents: 300 } }));
    expect(html).toContain('aria-label="Propina de 5 €. Total 41,30 €"');
  });

  it('con dos precios, sin total debajo', () => {
    const html = waiting(view());
    expect(html).not.toContain('. Total ');
    expect(text(html)).toContain('+3 €');
  });

  it('la línea de a quién va, siempre y en los dos idiomas', () => {
    expect(text(waiting(view()))).toContain('La propina va entera para el personal The whole tip goes to the staff');
    const venue = view({ tip: { ...view().tip!, toStaff: false } });
    expect(text(waiting(venue))).toContain('La propina es para el local The tip goes to the venue');
  });

  it('euros a clamp(var(--np-fs-18), 2.8vmin, 3.6vmin), total a clamp(var(--np-fs-16), 2.2vmin, 3vmin), 4.5rem de alto', () => {
    expect(rule(CSS, '.tipBtn')).toMatch(/min-height: 4\.5rem;/);
    expect(rule(CSS, '.tipBtn')).toMatch(/font-size: var\(--np-fs-18\);\s*font-size: clamp\(var\(--np-fs-18\), 2\.8vmin, 3\.6vmin\);/);
    expect(rule(CSS, '.tipTotal')).toMatch(/font-size: var\(--np-fs-16\);\s*font-size: clamp\(var\(--np-fs-16\), 2\.2vmin, 3vmin\);/);
    expect(rule(CSS, '.tipTotal')).toMatch(/color: var\(--np-text-mute\);/);
  });
});

describe('tablet: el inglés debajo de cada texto', () => {
  it('los textos de la lista, con lang="en"', () => {
    const en = (html: string) => [...html.matchAll(/<span lang="en" class="_en_[^"]*">([^<]*)<\/span>/g)].map((m) => m[1]!.replace(/&#x27;/g, "'"));
    expect(en(waiting(view({ cardAmountCents: null })))).toEqual(
      expect.arrayContaining(['Tip?', 'No tip', 'Other', "Hold your tag to the waiter's phone", 'or scan the QR with your phone']),
    );
    expect(en(waiting(view({ topUp: true, ficha: false, cardAmountCents: null, tip: null })))).toEqual(
      expect.arrayContaining(['Balance top-up', 'Scan the QR with your phone']),
    );
    expect(en(waiting(view({ paying: true, qrUrl: null })))).toEqual(
      expect.arrayContaining(['Finishing the payment…', "Paying on the customer's phone…"]),
    );
    expect(en(waiting(view({ ficha: false, qrUrl: null, cardAmountCents: null })))).toContain('Pay on the card reader');
    const reading = renderToStaticMarkup(
      <Waiting view={view()} nfcHere reading tipBusy={false} onTip={() => undefined} problem={null} />,
    );
    expect(en(reading)).toContain('Reading your tag…');
  });

  it('el inglés: peso 500, apagado y en su línea; nunca bajo 14 px', () => {
    const r = rule(CSS, '.en');
    expect(r).toMatch(/display: block;/);
    expect(r).toMatch(/font-weight: 500;/);
    expect(r).toMatch(/color: var\(--np-text-mute\);/);
    expect(r).toMatch(/font-size: var\(--np-fs-14\);\s*font-size: clamp\(var\(--np-fs-14\), 2vmin, 3vmin\);/);
    // La línea de a quién va (14 px): su inglés, al mismo tamaño (nunca bajo 14).
    expect(rule(CSS, '.tipNote .en')).toMatch(/font-size: 100%;/);
    expect(CSS).toMatch(/\.tipNote \{[^}]*var\(--np-fs-14\)/);
  });
});

describe('tablet: el «Pagado» dice cuánto', () => {
  it('«Pagado · Paid», el importe y «¡Gracias! · Thank you»', () => {
    const html = renderToStaticMarkup(<Paid cents={3930} />);
    expect(text(html)).toBe('Pagado Paid 39,30 € ¡Gracias! Thank you');
    expect(html).toContain('class="np-importe');
  });

  it('un API de antes (sin importe): solo «Pagado»', () => {
    expect(text(renderToStaticMarkup(<Paid cents={null} />))).toBe('Pagado Paid ¡Gracias! Thank you');
  });
});

describe('tablet: los errores se quedan; las notas se van', () => {
  let host: HTMLDivElement;
  let root: Root;
  let api: ReturnType<typeof useTabletFicha>;
  function Probe({ v }: { v: WaitingView | null }): ReactElement | null {
    api = useTabletFicha(v, () => undefined);
    return null;
  }
  beforeEach(() => {
    vi.useFakeTimers();
    host = document.body.appendChild(document.createElement('div'));
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it('un error (API, lectura, PIN bloqueado, propina) sigue a los 5 s; una nota (ficha vacía, sin PIN) no', () => {
    act(() => root.render(<Probe v={view()} />));
    act(() => {
      api.setProblem('No se ha podido elegir la propina.');
      api.setNote('Esta ficha está vacía: se carga en recepción.');
    });
    act(() => vi.advanceTimersByTime(5_000));
    expect(api.problem).toBe('No se ha podido elegir la propina.');
    expect(api.note).toBeNull();
  });

  it('el error se va con el siguiente cobro', () => {
    act(() => root.render(<Probe v={view()} />));
    act(() => api.setProblem('El PIN de esta ficha está bloqueado por fallos. Avisa al camarero.'));
    act(() => root.render(<Probe v={view({ key: 'k2' })} />));
    expect(api.problem).toBeNull();
  });

  it('el error va en FormError bajo el importe (role=alert), no en el aviso flotante', () => {
    const html = waiting(view(), 'No se ha podido pagar. Vuelve a intentarlo.');
    const amount = html.indexOf('_priceBlock_');
    const error = html.indexOf('class="np-form-error"');
    expect(error).toBeGreaterThan(amount);
    expect(html).toContain('<p role="alert" class="np-form-error">');
    expect(error).toBeLessThan(html.indexOf('role="radiogroup"'));
  });

  it('los textos de error son «problem»; las notas cortas, «note»', () => {
    const hook = read('../components/pantalla/use-tablet-ficha.ts');
    expect(hook).toMatch(/setNote\(EMPTY_FICHA_NOTE\)/);
    expect(hook).toMatch(/setNote\(NO_PIN_NOTE\)/);
    expect(hook).toMatch(/setProblem\(PIN_LOCKED_NOTE\)/);
    expect(hook).not.toMatch(/setNote\(err/);
    const screen = read('../components/pantalla/PantallaCliente.tsx');
    expect(screen).toMatch(/ficha\.setProblem\(err instanceof DisplayApiError \? err\.message : 'No se ha podido elegir la propina\.'\)/);
  });
});
