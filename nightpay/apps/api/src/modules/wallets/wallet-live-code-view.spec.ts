import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAY_LANGUAGES } from '../payments/customer-lang';
import { CLIENT_ERROR_JS, clientErrorConfig } from './client-errors';
import { LIVE_CODE_CSS, LIVE_CODE_JS, liveCodeCard } from './wallet-live-code-view';
import { WALLET_TEXT } from './wallet-text';

/**
 * «Pagar o recargar en otro sistema» en la página del saldo (/w): el botón y,
 * al tocarlo, el código del móvil (OXC1:) en un <img> con su `data:` (nunca
 * innerHTML), renovado cada 45 s mientras se ve y apagado a los 5 minutos.
 * «Ocultar el código» deja de pedir y devuelve el botón con el foco.
 */

const BACKSLASH = String.fromCharCode(92);
const QR = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=';

class FakeEl {
  hidden = false;
  textContent = '';
  focused = 0;
  scrolled: unknown[] = [];
  readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, Array<() => void>>();
  constructor(readonly id: string) {}
  set src(v: string) {
    this.attrs.set('src', v);
  }
  get src(): string {
    return this.attrs.get('src') ?? '';
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  focus(): void {
    this.focused += 1;
    doc.activeElement = this;
  }
  scrollIntoView(o: unknown): void {
    this.scrolled.push(o);
  }
  addEventListener(name: string, fn: () => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }
  click(): void {
    for (const fn of this.listeners.get('click') ?? []) fn();
  }
}

let doc: { visibilityState: string; activeElement: FakeEl | null; fire(): void; addEventListener(n: string, fn: () => void): void };

interface Harness {
  els: Map<string, FakeEl>;
  $: (id: string) => FakeEl;
  post: ReturnType<typeof vi.fn>;
  render: (s: Record<string, unknown>) => void;
  /** Lo que contesta /live-code la próxima vez. */
  next: Array<{ status: number; body?: unknown } | 'network'>;
}

function harness(lang: 'es' | 'en' = 'es', liveCode = true): Harness {
  const visibility: Array<() => void> = [];
  doc = {
    visibilityState: 'visible',
    activeElement: null,
    fire: () => visibility.forEach((fn) => fn()),
    addEventListener: (name, fn) => {
      if (name === 'visibilitychange') visibility.push(fn);
    },
  };
  const els = new Map<string, FakeEl>();
  const $ = (id: string): FakeEl => {
    let el = els.get(id);
    if (!el) {
      el = new FakeEl(id);
      els.set(id, el);
    }
    return el;
  };
  const next: Harness['next'] = [];
  const post = vi.fn(async () => {
    const r = next.shift() ?? { status: 200, body: { code: 'OXC1:X', qr: QR, expiresIn: 60 } };
    if (r === 'network') throw new TypeError('Failed to fetch');
    if (r.status >= 400) {
      const b = (r.body ?? {}) as { code?: string };
      throw Object.assign(new Error('Error'), { status: r.status, code: b.code });
    }
    return r.body;
  });
  const show = (id: string, text: string): void => {
    $(id).textContent = text || '';
    $(id).hidden = !text;
  };
  const C = { liveCode, errors: clientErrorConfig(lang) };
  const T = WALLET_TEXT[lang];
  const make = new Function(
    '$',
    'T',
    'C',
    'show',
    'post',
    'document',
    `${CLIENT_ERROR_JS}
function msg(e){return npErr(e,C.errors);}
${LIVE_CODE_JS}
return liveCodeRender;`,
  ) as (...a: unknown[]) => (s: Record<string, unknown>) => void;
  const render = make($, T, C, show, post, doc);
  return { els, $, post, render, next };
}

const ACTIVE = { status: 'ACTIVE', merged: false, refund: null };

/** Deja correr post → then → pintar. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('liveCodeCard: el HTML del bloque', () => {
  it.each(PAY_LANGUAGES)('%s: oculto de entrada (sin JS no sale), con la pista, el botón y lo que sale al tocarlo', (lang) => {
    const t = WALLET_TEXT[lang].liveCode;
    const html = liveCodeCard(lang);
    expect(html).toMatch(/^<section class="card lc" id="lcCard" hidden/);
    expect(html).toContain(`<button class="btn alt" type="button" id="lcOpen">`);
    expect(html).toContain(t.hint.replace(/'/g, '&#39;'));
    expect(html).toContain(`<div class="fqri" id="lcPlate" hidden><img id="lcImg" alt="`);
    // Sin `src` hasta que el JS lo pone (nada que cargar, ni de otro dominio).
    expect(html).not.toMatch(/<img[^>]*src=/);
    expect(html).toContain(`<button class="link" type="button" id="lcHide">`);
    expect(html).toContain('id="lcMsg" role="status" hidden');
    expect(html).toMatch(/id="lcBox" hidden/);
  });

  it('escapa los textos', () => {
    expect(liveCodeCard('en')).toContain('venue&#39;s');
    expect(liveCodeCard('en')).not.toContain("venue's");
  });

  it('CSS: el QR de la placa crema en un <img> a todo su ancho; botón de 48 px y enlace de 44 px', () => {
    expect(LIVE_CODE_CSS).toContain('.fqri img{display:block;width:100%;height:auto}');
    expect(LIVE_CODE_CSS).toContain('.lc .btn.alt{min-height:3rem;width:100%}');
    expect(LIVE_CODE_CSS).toContain('.lc .link{min-height:2.75rem}');
    expect(LIVE_CODE_CSS).toMatch(/\.lc \.fqri\{width:15rem;max-width:72%/);
  });

  it('JS válido, sin barras invertidas ni innerHTML; pide cada 45.000 ms y se apaga a los 300.000 ms', () => {
    expect(LIVE_CODE_JS.includes(BACKSLASH)).toBe(false);
    expect(LIVE_CODE_JS).not.toContain('innerHTML');
    expect(LIVE_CODE_JS).toContain('45000');
    expect(LIVE_CODE_JS).toContain('300000');
    expect(() => new Function(LIVE_CODE_JS)).not.toThrow();
  });
});

describe('LIVE_CODE_JS: el código del móvil en la página', () => {
  it('sale solo con liveCode y un saldo ACTIVE o DEPLETED; nunca sumado ni con devolución', () => {
    const h = harness();
    h.render(ACTIVE);
    expect(h.$('lcCard').hidden).toBe(false);
    h.render({ ...ACTIVE, status: 'DEPLETED' });
    expect(h.$('lcCard').hidden).toBe(false);
    h.render({ ...ACTIVE, status: 'DEPLETED', merged: true });
    expect(h.$('lcCard').hidden).toBe(true);
    h.render({ ...ACTIVE, refund: { stage: 'requested' } });
    expect(h.$('lcCard').hidden).toBe(true);
    for (const status of ['REFUNDED', 'EXPIRED', 'CLOSED']) {
      h.render({ ...ACTIVE, status });
      expect(h.$('lcCard').hidden).toBe(true);
    }
    const off = harness('es', false);
    off.render(ACTIVE);
    expect(off.$('lcCard').hidden).toBe(true);
  });

  it('al tocar: el botón se va, «Preparando…» y luego el QR en el <img>; el foco a «Ocultar el código»', async () => {
    const h = harness();
    h.render(ACTIVE);
    h.$('lcOpen').click();
    expect(h.$('lcOpen').hidden).toBe(true);
    expect(h.$('lcBox').hidden).toBe(false);
    expect(h.$('lcMsg').textContent).toBe(WALLET_TEXT.es.liveCode.loading);
    expect(h.$('lcHide').focused).toBe(1);
    expect(h.$('lcBox').scrolled).toEqual([{ block: 'nearest' }]);
    expect(h.post).toHaveBeenCalledWith('/live-code');
    await flush();
    expect(h.$('lcImg').src).toBe(QR);
    expect(h.$('lcPlate').hidden).toBe(false);
    expect(h.$('lcMsg').hidden).toBe(true);
  });

  it('pide otro cada 45 s mientras se ve, y a los 5 minutos se apaga (sin más peticiones)', async () => {
    const h = harness();
    h.render(ACTIVE);
    h.$('lcOpen').click();
    await flush();
    expect(h.post).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(h.post).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(h.post).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(300_000 - 45_000 - 1);
    await flush();
    const before = h.post.mock.calls.length;
    expect(before).toBe(7); // 0, 45, 90, 135, 180, 225, 270 s
    await vi.advanceTimersByTimeAsync(1);
    expect(h.$('lcMsg').textContent).toBe(WALLET_TEXT.es.liveCode.ended);
    expect(h.$('lcPlate').hidden).toBe(true);
    expect(h.$('lcImg').attrs.has('src')).toBe(false);
    expect(h.$('lcOpen').hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.post).toHaveBeenCalledTimes(before);
  });

  it('con la pestaña oculta deja de pedir; al volver, pide ya', async () => {
    const h = harness();
    h.render(ACTIVE);
    h.$('lcOpen').click();
    await flush();
    doc.visibilityState = 'hidden';
    doc.fire();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.post).toHaveBeenCalledTimes(1);
    doc.visibilityState = 'visible';
    doc.fire();
    await flush();
    expect(h.post).toHaveBeenCalledTimes(2);
  });

  it('«Ocultar el código»: ninguna petición más, sin placa y el botón otra vez con el foco', async () => {
    const h = harness();
    h.render(ACTIVE);
    h.$('lcOpen').click();
    await flush();
    h.$('lcHide').click();
    expect(h.$('lcBox').hidden).toBe(true);
    expect(h.$('lcPlate').hidden).toBe(true);
    expect(h.$('lcImg').attrs.has('src')).toBe(false);
    expect(h.$('lcOpen').hidden).toBe(false);
    expect(h.$('lcOpen').focused).toBe(1);
    await vi.advanceTimersByTimeAsync(400_000);
    doc.fire();
    await flush();
    expect(h.post).toHaveBeenCalledTimes(1);
  });

  it('una respuesta que llega tras ocultar no vuelve a enseñar el código', async () => {
    const h = harness();
    h.render(ACTIVE);
    h.$('lcOpen').click();
    h.$('lcHide').click();
    await flush();
    expect(h.$('lcPlate').hidden).toBe(true);
    expect(h.$('lcImg').attrs.has('src')).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.post).toHaveBeenCalledTimes(1);
  });

  it('errores: 5xx o sin respuesta → TRY_LATER; lo demás, su texto (npErr); deja de pedir', async () => {
    const E = clientErrorConfig('es');
    for (const [r, text] of [
      [{ status: 503, body: { code: 'TRY_LATER' } }, E.TRY_LATER],
      [{ status: 500 }, E.TRY_LATER],
      ['network', E.TRY_LATER],
      [{ status: 429 }, E.RATE_LIMITED],
      [{ status: 409, body: { code: 'NOPE' } }, E.generic],
    ] as const) {
      const h = harness();
      h.next.push(r);
      h.render(ACTIVE);
      h.$('lcOpen').click();
      await flush();
      expect(h.$('lcMsg').textContent).toBe(text);
      expect(h.$('lcPlate').hidden).toBe(true);
      expect(h.$('lcOpen').hidden).toBe(false);
      await vi.advanceTimersByTimeAsync(100_000);
      expect(h.post).toHaveBeenCalledTimes(1);
    }
  });

  it('un qr que no es un data: de SVG no se pone en el <img>', async () => {
    const h = harness();
    h.next.push({ status: 200, body: { code: 'OXC1:X', qr: 'https://evil.example/x.svg', expiresIn: 60 } });
    h.render(ACTIVE);
    h.$('lcOpen').click();
    await flush();
    expect(h.$('lcImg').attrs.has('src')).toBe(false);
    expect(h.$('lcMsg').textContent).toBe(clientErrorConfig('es').TRY_LATER);
  });

  it('si el saldo deja de valer (sumado) con el código a la vista, se quita y deja de pedir', async () => {
    const h = harness();
    h.render(ACTIVE);
    h.$('lcOpen').click();
    await flush();
    h.render({ ...ACTIVE, status: 'DEPLETED', merged: true });
    expect(h.$('lcCard').hidden).toBe(true);
    expect(h.$('lcImg').attrs.has('src')).toBe(false);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(h.post).toHaveBeenCalledTimes(1);
  });
});
