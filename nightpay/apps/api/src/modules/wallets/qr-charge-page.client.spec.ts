import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderQrChargePage } from './qr-charge-page';

/**
 * La página /s de verdad en el navegador: su <script> corre contra un DOM
 * mínimo (los elementos con id del HTML), un fetch falso y el reloj de vitest.
 * Así se prueba lo que ve el cliente, no solo que el JS esté en la página.
 */

const NOW = new Date('2026-10-15T22:00:00Z');
const MIN = 60_000;
const view = {
  status: 'PENDING' as const,
  amountCents: 6000,
  serviceName: 'Masaje',
  venueName: 'Luna',
  requestedByName: 'Lola',
  expiresAt: new Date(NOW.getTime() + 5 * MIN).toISOString(),
  paidAt: null,
};

class FakeEl {
  textContent = '';
  disabled = false;
  className = '';
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, Array<() => void>>();
  private readonly children = new Map<string, FakeEl>();
  readonly classList = {
    set: new Set<string>(),
    add: (c: string) => this.classList.set.add(c),
    remove: (c: string) => this.classList.set.delete(c),
    contains: (c: string) => this.classList.set.has(c),
  };

  constructor(
    readonly id: string,
    public hidden = false,
  ) {}

  addEventListener(type: string, fn: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  click(): void {
    for (const fn of this.listeners.get('click') ?? []) fn();
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  querySelector(selector: string): FakeEl {
    const found = this.children.get(selector) ?? new FakeEl(selector);
    this.children.set(selector, found);
    return found;
  }
  appendChild(): void {}
  insertBefore(): void {}
}

/** Respuesta del fetch falso: un status y un cuerpo JSON (o que la red falle). */
type Reply = { status: number; body?: unknown } | 'network';

function respond(reply: Reply): Promise<Response> {
  if (reply === 'network') return Promise.reject(new TypeError('Failed to fetch'));
  return Promise.resolve({
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    json: async () => reply.body ?? {},
  } as Response);
}

const bytes = (): ArrayBuffer => new Uint8Array([1, 2, 3]).buffer;

/** Abre la página con el reloj del móvil en `phoneNow` y las respuestas del servidor. */
function openPage(opts: { phoneNow?: Date; pay?: Reply; state?: Reply[]; serverNow?: Date } = {}) {
  vi.setSystemTime(opts.phoneNow ?? NOW);
  const html = renderQrChargePage('tok-1', 'es', view, opts.serverNow ?? NOW);
  const els = new Map<string, FakeEl>();
  for (const m of html.matchAll(/<[a-z0-9]+ [^>]*\bid="([A-Za-z]+)"[^>]*>/g)) {
    const found = new FakeEl(m[1]!, / hidden>$/.test(m[0]));
    // Lo que lee npPaid del HTML: cuánto dura el «Pagado» en verde.
    const fresh = /\bdata-fresh="(\d+)"/.exec(m[0]);
    if (fresh) found.setAttribute('data-fresh', fresh[1]!);
    els.set(m[1]!, found);
  }
  const states = [...(opts.state ?? [])];
  const calls: string[] = [];
  const fetchFake = vi.fn((url: string) => {
    calls.push(url);
    if (url.endsWith('/challenge')) return respond({ status: 200, body: { challenge: 'AQID', allowCredentials: [] } });
    if (url.endsWith('/pay')) return respond(opts.pay ?? { status: 200, body: { amountCents: 6000, balanceCents: 4000, code: null } });
    if (url.endsWith('/state')) return respond(states.shift() ?? 'network');
    return respond({ status: 404 });
  });
  const reload = vi.fn();
  const doc = {
    getElementById: (id: string) => els.get(id) ?? null,
    createElement: () => new FakeEl(''),
    addEventListener: () => undefined,
    visibilityState: 'visible',
  };
  const win = { PublicKeyCredential: function PublicKeyCredential() {}, scrollTo: () => undefined, addEventListener: () => undefined };
  const nav = {
    credentials: {
      get: async () => ({
        id: 'cred',
        rawId: bytes(),
        type: 'public-key',
        response: { clientDataJSON: bytes(), authenticatorData: bytes(), signature: bytes(), userHandle: null },
        authenticatorAttachment: 'platform',
        getClientExtensionResults: () => ({}),
      }),
    },
  };
  const js = html.split('<script>').slice(1).map((part) => part.slice(0, part.indexOf('</script>'))).join('\n');
  new Function('document', 'window', 'navigator', 'fetch', 'location', js)(doc, win, nav, fetchFake, { reload });
  const el = (id: string): FakeEl => {
    const found = els.get(id);
    if (!found) throw new Error(`sin #${id}`);
    return found;
  };
  return { el, reload, calls };
}

/** Deja correr las promesas y los temporizadores de la página. */
const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

async function tapPay(page: ReturnType<typeof openPage>): Promise<void> {
  await settle();
  page.el('pay').click();
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('/s en el móvil: la cuenta atrás va con la hora del servidor', () => {
  it('móvil con la hora 6 min adelantada: el cobro sigue vivo (5:00) y se puede pagar', async () => {
    const page = openPage({ phoneNow: new Date(NOW.getTime() + 6 * MIN) });
    await settle();
    expect(page.el('pay').hidden).toBe(false);
    expect(page.el('clock').textContent).toBe('Caduca en 5:00');
    expect(page.el('error').textContent).toBe('');
    await settle(61_000);
    expect(page.el('clock').textContent).toBe('Caduca en 3:59');
  });

  it('móvil con la hora atrasada: caduca cuando caduca en el servidor (no más tarde)', async () => {
    const page = openPage({ phoneNow: new Date(NOW.getTime() - 10 * MIN) });
    await settle(5 * MIN + 1_000);
    expect(page.el('pay').hidden).toBe(true);
    expect(page.el('error').textContent).toBe('Este cobro ha caducado. Pide al personal que lo repita.');
  });
});

describe('/s en el móvil: un fallo que no se sabe si cobró no dice «no se ha cobrado nada» ni deja pagar a ciegas', () => {
  it('pagado bien: el «Pagado» con lo que le queda', async () => {
    const page = openPage();
    await tapPay(page);
    expect(page.el('paid').hidden).toBe(false);
    expect(page.el('ask').hidden).toBe(true);
  });

  for (const pay of [{ status: 408 }, { status: 429 }, { status: 502 }, { status: 504 }, 'network'] as Reply[]) {
    const name = pay === 'network' ? 'sin respuesta' : `HTTP ${pay.status}`;

    it(`${name} y el cobro sigue pendiente: lo comprueba y entonces sí deja volver a intentarlo`, async () => {
      const page = openPage({ pay, state: [{ status: 200, body: { status: 'PENDING' } }] });
      await tapPay(page);
      expect(page.calls.filter((u) => u.endsWith('/state'))).toHaveLength(1);
      expect(page.el('notCharged').hidden).toBe(true);
      expect(page.el('error').textContent).toBe('Este cobro sigue sin pagar: puedes volver a intentarlo.');
      expect(page.el('pay').hidden).toBe(false);
      expect(page.el('pay').disabled).toBe(false);
      expect(page.reload).not.toHaveBeenCalled();
    });

    it(`${name} pero se cobró: el PAGADO normal de ese cobro, con su código (no el gris «No es un pago nuevo»)`, async () => {
      const page = openPage({ pay, state: [{ status: 200, body: { status: 'ACCEPTED', code: '7QK' } }] });
      await tapPay(page);
      expect(page.reload).not.toHaveBeenCalled();
      expect(page.el('paid').hidden).toBe(false);
      expect(page.el('ask').hidden).toBe(true);
      expect(page.el('paid').classList.contains('stale')).toBe(false);
      expect(page.el('paid').querySelector('[data-title]').textContent).toBe('Pagado');
      expect(page.el('paid').querySelector('[data-amount]').textContent).toMatch(/^60/);
      expect(page.el('notCharged').hidden).toBe(true);
    });

    it(`${name} y el cobro ya no está (caducado, cancelado): recarga y se ve el estado real`, async () => {
      const page = openPage({ pay, state: [{ status: 200, body: { status: 'EXPIRED' } }] });
      await tapPay(page);
      expect(page.reload).toHaveBeenCalledTimes(1);
      expect(page.el('paid').hidden).toBe(true);
    });
  }

  it('tampoco responde la comprobación (lo intenta 3 veces): «No sabemos si se ha cobrado» y solo «Volver a cargar»', async () => {
    const page = openPage({ pay: { status: 504 }, state: ['network', { status: 503 }, 'network'] });
    await tapPay(page);
    await settle(5_000);
    expect(page.calls.filter((u) => u.endsWith('/state'))).toHaveLength(3);
    expect(page.el('error').textContent).toBe('No sabemos si se ha cobrado. Vuelve a cargar la página antes de pagar otra vez.');
    expect(page.el('pay').hidden).toBe(true);
    expect(page.el('reload').hidden).toBe(false);
    expect(page.el('notCharged').hidden).toBe(true);
  });

  it('la comprobación responde a la segunda: decide con esa', async () => {
    const page = openPage({ pay: 'network', state: ['network', { status: 200, body: { status: 'PENDING' } }] });
    await tapPay(page);
    await settle(2_000);
    expect(page.el('pay').hidden).toBe(false);
    expect(page.el('reload').hidden).toBe(true);
  });

  it('un 200 sin lo cobrado (un proxy que contesta otra cosa) tampoco se da por pagado ni por no cobrado: decide el estado del servidor', async () => {
    const page = openPage({ pay: { status: 200, body: {} }, state: [{ status: 200, body: { status: 'PENDING' } }] });
    await tapPay(page);
    expect(page.calls.filter((u) => u.endsWith('/state'))).toHaveLength(1);
    expect(page.el('paid').hidden).toBe(true);
    expect(page.el('notCharged').hidden).toBe(true);
    expect(page.el('pay').hidden).toBe(false);
  });

  it('un 4xx que es rechazo (Face ID, local en pausa…): «No se te ha cobrado nada» y se puede repetir, sin comprobar', async () => {
    const page = openPage({ pay: { status: 423, body: { code: 'VENUE_PAUSED', message: 'Local en pausa' } } });
    await tapPay(page);
    expect(page.calls.some((u) => u.endsWith('/state'))).toBe(false);
    expect(page.el('notCharged').hidden).toBe(false);
    expect(page.el('pay').hidden).toBe(false);
  });

  it('409 (ya no está pendiente): «Volver a cargar», sin «Pagar»', async () => {
    const page = openPage({ pay: { status: 409, body: { code: 'CHARGE_NOT_PENDING', message: 'Este cobro ya no está pendiente' } } });
    await tapPay(page);
    expect(page.el('pay').hidden).toBe(true);
    expect(page.el('reload').hidden).toBe(false);
    expect(page.el('notCharged').hidden).toBe(true);
  });
});
