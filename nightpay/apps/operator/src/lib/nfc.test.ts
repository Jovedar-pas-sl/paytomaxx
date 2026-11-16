import { afterEach, describe, expect, it, vi } from 'vitest';
import { nfcHub, nfcSupported, readCard } from './nfc';

describe('fichas NFC', () => {
  it('sin Web NFC (iPhone, ordenador): la app no intenta leer', () => {
    expect(nfcSupported()).toBe(false);
  });
});

describe('leer la ficha desde una pantalla (Web NFC)', () => {
  const scans: AbortSignal[] = [];
  class FakeReader {
    onreading: ((e: unknown) => void) | null = null;
    onreadingerror: ((e: Event) => void) | null = null;
    async scan(options: { signal: AbortSignal }): Promise<void> {
      scans.push(options.signal);
      setTimeout(() => this.onreading?.({ serialNumber: '04:a2:3b:1c', message: { records: [] } }), 0);
    }
    async write(): Promise<void> {}
  }

  afterEach(() => {
    nfcHub()?.stop();
    vi.unstubAllGlobals();
    scans.length = 0;
  });

  it('al leer y dejar de esperar (Pagado), la escucha NO se para: Android no abre el enlace de la ficha', async () => {
    vi.stubGlobal('window', { NDEFReader: FakeReader });
    const ctrl = new AbortController();
    await expect(readCard(ctrl.signal)).resolves.toMatchObject({ uid: '04A23B1C', blank: true });
    ctrl.abort();
    expect(scans).toHaveLength(1);
    expect(scans[0]!.aborted).toBe(false);
    // La pantalla siguiente usa la misma escucha.
    void readCard(new AbortController().signal).catch(() => undefined);
    expect(scans).toHaveLength(1);
  });
});
