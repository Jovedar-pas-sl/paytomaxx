import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WALLET_LIVE_JS } from './wallet-live';

/**
 * La página del saldo al momento (H-1, M-7), en el navegador: escucha los
 * avisos (EventSource a /w/:token/events) y solo entonces pide /state; de
 * respaldo, cada 20–30 s. Reconecta con espera creciente, para con la pestaña
 * oculta, y tras fallos o un 429 enseña «Reconectando…» en vez de callarse.
 */

type Listener = (e: { data?: string }) => void;

class FakeEventSource {
  static all: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Listener[]>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.all.push(this);
  }
  addEventListener(name: string, fn: Listener): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }
  close(): void {
    this.closed = true;
  }
  emit(name: string, data?: unknown): void {
    for (const fn of this.listeners.get(name) ?? []) fn({ data: data === undefined ? undefined : JSON.stringify(data) });
  }
  fail(): void {
    this.onerror?.();
  }
}

interface Harness {
  live: { refresh(): void; start(): void; stop(): void };
  fetch: ReturnType<typeof vi.fn>;
  states: unknown[];
  bar: boolean[];
  doc: { visibilityState: string; fire(): void };
  win: { firePageshow(persisted: boolean): void };
  unauth: ReturnType<typeof vi.fn>;
  gone: ReturnType<typeof vi.fn>;
  busy: { on: boolean };
  /** Lo que contesta /state la próxima vez. */
  next: Array<{ status: number; body?: unknown } | 'network'>;
  latest: () => FakeEventSource | undefined;
}

function harness(opts: { eventSource?: boolean } = {}): Harness {
  FakeEventSource.all = [];
  const next: Harness['next'] = [];
  const fetch = vi.fn(async () => {
    const r = next.shift() ?? { status: 200, body: { balanceCents: 1 } };
    if (r === 'network') throw new Error('Failed to fetch');
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body };
  });
  const visibility: Array<() => void> = [];
  const pageshow: Array<(e: { persisted: boolean }) => void> = [];
  const doc = {
    visibilityState: 'visible',
    addEventListener: (name: string, fn: () => void) => {
      if (name === 'visibilitychange') visibility.push(fn);
    },
    fire: () => visibility.forEach((fn) => fn()),
  };
  const win = {
    setTimeout,
    clearTimeout,
    addEventListener: (name: string, fn: (e: { persisted: boolean }) => void) => {
      if (name === 'pageshow') pageshow.push(fn);
    },
    firePageshow: (persisted: boolean) => pageshow.forEach((fn) => fn({ persisted })),
  };
  const states: unknown[] = [];
  const bar: boolean[] = [];
  const unauth = vi.fn();
  const gone = vi.fn();
  const busy = { on: false };
  const npLive = new Function(`${WALLET_LIVE_JS}; return npLive;`)() as (o: Record<string, unknown>) => Harness['live'];
  const live = npLive({
    base: '/w/tok',
    fetch,
    doc,
    win,
    EventSource: opts.eventSource === false ? null : FakeEventSource,
    busy: () => busy.on,
    state: (s: unknown) => states.push(s),
    bar: (on: boolean) => bar.push(on),
    unauth,
    gone,
  });
  return { live, fetch, states, bar, doc, win, unauth, gone, busy, next, latest: () => FakeEventSource.all.at(-1) };
}

/** Deja correr fetch → json → render. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('npLive: la página del saldo al momento', () => {
  it('JS sin barras invertidas (va dentro de una plantilla de TypeScript)', () => {
    expect(WALLET_LIVE_JS.includes(String.fromCharCode(92))).toBe(false);
    expect(() => new Function(WALLET_LIVE_JS)).not.toThrow();
  });

  it('al empezar escucha los avisos de su saldo; un aviso → pide /state y pinta (al momento, sin esperar al sondeo)', async () => {
    const h = harness();
    h.live.start();
    expect(h.latest()!.url).toBe('/w/tok/events');
    h.latest()!.emit('hello', { at: 1 });
    expect(h.fetch).not.toHaveBeenCalled();
    h.latest()!.emit('change', { at: 2 });
    await flush();
    expect(h.fetch).toHaveBeenCalledWith('/w/tok/state', expect.objectContaining({ cache: 'no-store' }));
    expect(h.states).toEqual([{ balanceCents: 1 }]);
  });

  it('respaldo: con el aviso funcionando, una consulta cada 30 s; sin él, cada 20 s', async () => {
    const h = harness();
    h.live.start();
    h.latest()!.emit('hello');
    await vi.advanceTimersByTimeAsync(29_000);
    expect(h.fetch).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const noSse = harness({ eventSource: false });
    noSse.live.start();
    await vi.advanceTimersByTimeAsync(20_000);
    await flush();
    expect(noSse.fetch).toHaveBeenCalledTimes(1);
  });

  it('se corta el aviso: pide /state ya y reconecta con espera creciente (1 s, 2 s, 4 s… hasta 30 s)', async () => {
    const h = harness();
    h.live.start();
    const first = h.latest()!;
    first.fail();
    expect(first.closed).toBe(true);
    await flush();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const waits: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const before = FakeEventSource.all.length;
      let waited = 0;
      while (FakeEventSource.all.length === before && waited < 60_000) {
        await vi.advanceTimersByTimeAsync(250);
        waited += 250;
      }
      waits.push(waited);
      h.latest()!.fail();
      await flush();
    }
    // Con el azar a la mitad (×0,75): 0,75 s, 1,5 s, 3 s, 6 s, 12 s, 22,5 s y el tope.
    expect(waits.slice(0, 5)).toEqual([750, 1500, 3000, 6000, 12000]);
    expect(Math.max(...waits)).toBeLessThanOrEqual(30_000);
  });

  it('al volver a entrar tras un corte, se pone al día (un aviso pudo perderse en el hueco); la primera vez, no', async () => {
    const h = harness();
    h.live.start();
    h.latest()!.emit('hello');
    await flush();
    expect(h.fetch).not.toHaveBeenCalled();
    h.latest()!.emit('bye', { r: 'renew' });
    await vi.advanceTimersByTimeAsync(0);
    h.latest()!.emit('hello');
    await flush();
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('el primer «hola» tras fallos (del aviso o de /state) también se pone al día y quita «Reconectando…» ya', async () => {
    const h = harness();
    h.live.start();
    h.next.push({ status: 429 });
    h.latest()!.fail();
    await flush();
    expect(h.bar.at(-1)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeEventSource.all).toHaveLength(2);
    const calls = h.fetch.mock.calls.length;
    h.latest()!.emit('hello');
    await flush();
    expect(h.fetch.mock.calls.length).toBe(calls + 1);
    expect(h.bar.at(-1)).toBe(false);
  });

  it('«bye»: renew vuelve a entrar ya; restart, en 1–5 s; cap (otra pestaña del saldo) ya no vuelve y sigue con el sondeo', async () => {
    const h = harness();
    h.live.start();
    h.latest()!.emit('bye', { r: 'renew' });
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeEventSource.all).toHaveLength(2);
    h.latest()!.emit('bye', { r: 'restart' });
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeEventSource.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(FakeEventSource.all).toHaveLength(3);
    h.latest()!.emit('bye', { r: 'cap' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeEventSource.all).toHaveLength(3);
    // Sin aviso, el respaldo cada 20 s sigue.
    expect(h.fetch.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it('«resync» (volvió la escucha en el servidor): pide /state con algo de azar (no todas las páginas a la vez)', async () => {
    const h = harness();
    h.live.start();
    h.latest()!.emit('hello');
    h.latest()!.emit('resync');
    expect(h.fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_500);
    await flush();
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('pestaña oculta: cierra el aviso y no pregunta; al volver, pregunta ya y vuelve a escuchar', async () => {
    const h = harness();
    h.live.start();
    const es = h.latest()!;
    h.doc.visibilityState = 'hidden';
    h.doc.fire();
    expect(es.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.fetch).not.toHaveBeenCalled();
    h.doc.visibilityState = 'visible';
    h.doc.fire();
    await flush();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.all).toHaveLength(2);
  });

  it('volver con «atrás» (la página sale de la caché del navegador): se pone al día y vuelve a escuchar', async () => {
    const h = harness();
    h.live.start();
    h.win.firePageshow(true);
    await flush();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.all).toHaveLength(2);
  });

  it('M-7: un 429 → «Reconectando…» al momento; dos fallos seguidos, también; la siguiente buena lo quita', async () => {
    const h = harness();
    h.live.start();
    h.next.push({ status: 429 });
    h.live.refresh();
    await flush();
    expect(h.bar.at(-1)).toBe(true);
    h.live.refresh();
    await flush();
    expect(h.bar.at(-1)).toBe(false);
    h.next.push('network', { status: 503 });
    h.live.refresh();
    await flush();
    expect(h.bar.at(-1)).toBe(false);
    h.live.refresh();
    await flush();
    expect(h.bar.at(-1)).toBe(true);
    // Tras un fallo se vuelve a probar pronto (5 s, 10 s…), no a los 20–30 s.
    const calls = h.fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    await flush();
    expect(h.fetch.mock.calls.length).toBe(calls + 1);
    expect(h.bar.at(-1)).toBe(false);
  });

  it('401 (la sesión del Face ID caducó): al desbloqueo, y no pregunta más', async () => {
    const h = harness();
    h.live.start();
    h.next.push({ status: 401 });
    h.live.refresh();
    await flush();
    expect(h.unauth).toHaveBeenCalledTimes(1);
    expect(h.latest()!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('404 (el enlace ya no vale: el dueño dio otro): lo dice y deja de preguntar', async () => {
    const h = harness();
    h.live.start();
    h.next.push({ status: 404 });
    h.live.refresh();
    await flush();
    expect(h.gone).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.bar.at(-1)).toBe(false);
  });

  it('con algo a medias (activando Face ID, eligiendo PIN…) no pinta encima: lo vuelve a intentar luego', async () => {
    const h = harness();
    h.live.start();
    h.busy.on = true;
    h.latest()!.emit('change');
    await flush();
    expect(h.fetch).not.toHaveBeenCalled();
    h.busy.on = false;
    await vi.advanceTimersByTimeAsync(20_000);
    await flush();
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('varios avisos seguidos: nunca dos /state a la vez; uno más al acabar (el último cambio se ve)', async () => {
    const h = harness();
    h.live.start();
    let release: () => void = () => undefined;
    h.fetch.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ status: 200, ok: true, json: async () => ({ v: 1 }) }))),
    );
    h.latest()!.emit('change');
    h.latest()!.emit('change');
    h.latest()!.emit('change');
    expect(h.fetch).toHaveBeenCalledTimes(1);
    release();
    await flush();
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.states).toEqual([{ v: 1 }, { balanceCents: 1 }]);
  });
});
