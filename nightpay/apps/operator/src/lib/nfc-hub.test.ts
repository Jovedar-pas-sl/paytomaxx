import { describe, expect, it, vi } from 'vitest';
import { createNfcHub, SAME_FICHA_GRACE_MS, type NdefReaderLike, type NdefReadingEvent } from './nfc-hub';

// Una sola escucha NFC para toda la app: mientras escucha, Android no reparte la
// ficha (no abre su enlace en Chrome). Se prueba con un NDEFReader de mentira.

interface Scan {
  reader: FakeReader;
  signal: AbortSignal;
}

let scans: Scan[] = [];
let scanFails: Error | null = null;

class FakeReader implements NdefReaderLike {
  onreading: ((event: NdefReadingEvent) => void) | null = null;
  onreadingerror: ((event: Event) => void) | null = null;
  async scan(options?: { signal?: AbortSignal }): Promise<void> {
    if (scanFails) throw scanFails;
    scans.push({ reader: this, signal: options!.signal! });
  }
  async write(): Promise<void> {}
}

/** Las escuchas que siguen vivas (sin abort). */
const live = () => scans.filter((s) => !s.signal.aborted);

/** Acerca una ficha al aparato: la oye la escucha viva. */
function tap(serial: string) {
  const event = { serialNumber: serial, message: { records: [] } } as unknown as NdefReadingEvent;
  for (const s of live()) s.reader.onreading?.(event);
}

function fakeDoc() {
  const listeners = new Set<() => void>();
  return {
    visibilityState: 'visible',
    addEventListener: (_: 'visibilitychange', l: () => void) => void listeners.add(l),
    removeEventListener: (_: 'visibilitychange', l: () => void) => void listeners.delete(l),
    set(state: 'visible' | 'hidden') {
      this.visibilityState = state;
      for (const l of listeners) l();
    },
  };
}

function setup(permission = 'granted') {
  scans = [];
  scanFails = null;
  let clock = 1_000_000;
  const doc = fakeDoc();
  const hub = createNfcHub({
    Reader: FakeReader,
    doc,
    permissions: { query: async () => ({ state: permission }) },
    now: () => clock,
  });
  return { hub, doc, advance: (ms: number) => (clock += ms) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('la escucha NFC de toda la app', () => {
  it('reparte la ficha a la pantalla que la espera, con una sola escucha', async () => {
    const { hub } = setup();
    const reading = hub.next(new AbortController().signal);
    await flush();
    expect(live()).toHaveLength(1);
    tap('04:a2:3b:1c');
    await expect(reading).resolves.toMatchObject({ serialNumber: '04:a2:3b:1c' });
    // Otra pantalla espera después: la misma escucha, no otra.
    void hub.next(new AbortController().signal);
    await flush();
    expect(scans).toHaveLength(1);
  });

  it('la pantalla deja de esperar (Pagado, Cancelar…) y la escucha sigue: Android no abre la ficha', async () => {
    const { hub } = setup();
    const ctrl = new AbortController();
    const reading = hub.next(ctrl.signal);
    await flush();
    ctrl.abort();
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    expect(hub.listening()).toBe(true);
    expect(live()).toHaveLength(1);
  });

  it('sin nadie esperándola se la traga: no la recibe nadie y sale el aviso', async () => {
    const { hub } = setup();
    await hub.startIfAllowed();
    const idle = vi.fn();
    hub.onIdleTap(idle);
    // Una pantalla que ya no espera (canceló) no la recibe.
    const ctrl = new AbortController();
    const gone = hub.next(ctrl.signal).catch(() => 'cancelado');
    ctrl.abort();
    tap('04:a2:3b:1c');
    expect(idle).toHaveBeenCalledTimes(1);
    await expect(gone).resolves.toBe('cancelado');
  });

  it('ignora la misma ficha durante 3 s tras usarla (no cobra dos veces); otra ficha sí vale', async () => {
    const { hub, advance } = setup();
    const idle = vi.fn();
    hub.onIdleTap(idle);
    const first = hub.next(new AbortController().signal);
    await flush();
    tap('04:a2:3b:1c');
    await first;

    const second = vi.fn();
    void hub.next(new AbortController().signal).then(second);
    advance(SAME_FICHA_GRACE_MS - 500);
    tap('04:a2:3b:1c');
    await flush();
    expect(second).not.toHaveBeenCalled();
    expect(idle).not.toHaveBeenCalled();

    tap('04:99:88:77');
    await flush();
    expect(second).toHaveBeenCalledWith(expect.objectContaining({ serialNumber: '04:99:88:77' }));

    // Pasados los 3 s, la misma ficha vuelve a valer.
    advance(SAME_FICHA_GRACE_MS);
    const third = hub.next(new AbortController().signal);
    tap('04:99:88:77');
    await expect(third).resolves.toMatchObject({ serialNumber: '04:99:88:77' });
  });

  it('tras grabar, la lectura de comprobación llega aunque sea la misma ficha', async () => {
    const { hub } = setup();
    const first = hub.next(new AbortController().signal);
    await flush();
    tap('04:a2:3b:1c');
    await first;
    const seen = vi.fn();
    const unfollow = hub.follow(seen);
    tap('04:a2:3b:1c');
    expect(seen).toHaveBeenCalledTimes(1);
    unfollow();
  });

  it('para al ocultarse la app y se reanuda al volver; quien esperaba sigue esperando', async () => {
    const { hub, doc } = setup();
    const reading = hub.next(new AbortController().signal);
    await flush();
    doc.set('hidden');
    expect(hub.listening()).toBe(false);
    expect(live()).toHaveLength(0);
    doc.set('visible');
    await flush();
    expect(hub.listening()).toBe(true);
    expect(live()).toHaveLength(1);
    tap('04:a2:3b:1c');
    await expect(reading).resolves.toMatchObject({ serialNumber: '04:a2:3b:1c' });
  });

  it('con el permiso NFC dado arranca sola; sin él, espera al primer «Acercar»', async () => {
    const granted = setup('granted');
    await expect(granted.hub.startIfAllowed()).resolves.toBe(true);
    expect(granted.hub.listening()).toBe(true);

    const prompt = setup('prompt');
    await expect(prompt.hub.startIfAllowed()).resolves.toBe(false);
    expect(prompt.hub.listening()).toBe(false);
    void prompt.hub.next(new AbortController().signal);
    expect(prompt.hub.listening()).toBe(true);

    // Un navegador que no sabe del permiso «nfc»: tampoco arranca sola.
    const unknown = createNfcHub({
      Reader: FakeReader,
      permissions: {
        query: () => {
          throw new TypeError('nfc');
        },
      },
    });
    await expect(unknown.startIfAllowed()).resolves.toBe(false);
  });

  it('si Chrome no deja escuchar (sin permiso), la pantalla que espera recibe el error', async () => {
    const { hub } = setup('prompt');
    scanFails = new DOMException('Sin permiso', 'NotAllowedError');
    await expect(hub.next(new AbortController().signal)).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(hub.listening()).toBe(false);
  });

  it('una ficha que no se puede leer: error para quien la espera', async () => {
    const { hub } = setup();
    const reading = hub.next(new AbortController().signal);
    await flush();
    for (const s of live()) s.reader.onreadingerror?.(new Event('readingerror'));
    await expect(reading).rejects.toThrow('No se ha podido leer la ficha');
  });
});
