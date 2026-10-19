import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChipError, isChipTimeout, isFatalChipError, tapChip, tapFromBridge } from './chip-tap';

const FICHA = 'Kp3vX9qL2mN8rT5wYb7c';
const URL_FICHA = `https://operator.x/?ficha=${FICHA}`;

describe('la ficha que devuelve el puente del datáfono', () => {
  it('leída con nuestro enlace: su código y su número de serie', () => {
    expect(tapFromBridge({ ok: true, uid: '04:a2:3b:1c:2d:5e:80', url: URL_FICHA })).toEqual({
      token: FICHA, uid: '04A23B1C2D5E80', written: false, other: false,
    });
  });

  it('leída en blanco (sin enlace): sin código, no es «otra cosa»', () => {
    expect(tapFromBridge({ ok: true, uid: '04A2', url: null })).toEqual({ token: null, uid: null, written: false, other: false });
  });

  it('grabada ahora: el código que se le grabó', () => {
    expect(tapFromBridge({ ok: true, uid: '04A23B1C', url: URL_FICHA, written: true })).toMatchObject({ token: FICHA, written: true, other: false });
  });

  it('no se grabó porque ya tenía algo que no es nuestro: «otra cosa», no se toca', () => {
    expect(tapFromBridge({ ok: true, uid: '04A23B1C', url: 'https://otra-web.es/promo', written: false })).toMatchObject({
      token: null, other: true,
    });
    // Con algo grabado que no es un enlace: tampoco.
    expect(tapFromBridge({ ok: true, uid: '04A23B1C', url: null, written: false })).toMatchObject({ token: null, other: true });
  });

  it('errores del lector con su texto; cancelar es un AbortError', () => {
    expect(() => tapFromBridge({ ok: false, error: 'readOnly' })).toThrow(/protegida/);
    expect(() => tapFromBridge({ ok: false, error: 'tooSmall' })).toThrow(/NTAG213/);
    expect(() => tapFromBridge({ ok: false, error: 'raro', message: 'Algo pasó' })).toThrow('Algo pasó');
    expect(() => tapFromBridge({ ok: false, error: 'cancelled' })).toThrow(expect.objectContaining({ name: 'AbortError' }));
  });

  it('qué fallos paran «Preparar fichas» y cuáles solo esperan otra', () => {
    expect(isFatalChipError(new ChipError('nfcUnavailable'))).toBe(true);
    expect(isFatalChipError(new ChipError('notSupported'))).toBe(true);
    expect(isFatalChipError(new ChipError('writeFailed'))).toBe(false);
    expect(isFatalChipError(Object.assign(new Error('x'), { name: 'NotAllowedError' }))).toBe(true);
    expect(isFatalChipError(new Error('PIN'))).toBe(false);
    expect(isChipTimeout(new ChipError('timeout'))).toBe(true);
    expect(isChipTimeout(new ChipError('writeFailed'))).toBe(false);
  });
});

describe('acercar la ficha en el datáfono (writeNfc / readNfc)', () => {
  type Win = { NightPayPax?: Record<string, (json: string) => void>; nightpayPaxCallback?: (id: string, json: string) => void };
  let win: Win;
  const calls: Array<[string, Record<string, unknown>]> = [];

  function answer(method: string, reply: (req: Record<string, unknown>) => unknown | null) {
    win.NightPayPax![method] = (raw: string) => {
      const req = JSON.parse(raw) as Record<string, unknown>;
      calls.push([method, req]);
      const out = reply(req);
      if (out !== null) setTimeout(() => win.nightpayPaxCallback?.(String(req.requestId), JSON.stringify(out)), 0);
    };
  }

  beforeEach(() => {
    calls.length = 0;
    win = { NightPayPax: {} };
    vi.stubGlobal('window', win);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('con código para las fichas en blanco: se pide antes y la app graba solo si está en blanco', async () => {
    answer('writeNfc', (req) => ({ ok: true, uid: '04A23B1C', url: req.url, written: true }));
    const blankUrl = vi.fn(async () => URL_FICHA);
    await expect(tapChip('bridge', new AbortController().signal, blankUrl)).resolves.toMatchObject({ token: FICHA, written: true });
    expect(blankUrl).toHaveBeenCalledTimes(1);
    expect(calls[0]).toEqual(['writeNfc', expect.objectContaining({ url: URL_FICHA, onlyIfBlank: true, timeoutMs: 60_000 })]);
  });

  it('sin código: solo lee (readNfc)', async () => {
    answer('readNfc', () => ({ ok: true, uid: '04A23B1C', url: URL_FICHA }));
    await expect(tapChip('bridge', new AbortController().signal)).resolves.toMatchObject({ token: FICHA, written: false });
    expect(calls.map(([m]) => m)).toEqual(['readNfc']);
  });

  it('cancelar en la pantalla corta la espera en la app (cancelRead)', async () => {
    let pendingId = '';
    answer('writeNfc', (req) => {
      pendingId = String(req.requestId);
      return null;
    });
    answer('cancelRead', () => {
      setTimeout(() => win.nightpayPaxCallback?.(pendingId, JSON.stringify({ ok: false, error: 'cancelled' })), 0);
      return { ok: true };
    });
    const controller = new AbortController();
    const tapping = tapChip('bridge', controller.signal, async () => URL_FICHA);
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    await expect(tapping).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls.map(([m]) => m)).toEqual(['writeNfc', 'cancelRead']);
  });

  it('una app del datáfono vieja sin writeNfc: se dice que hay que actualizarla', async () => {
    await expect(tapChip('bridge', new AbortController().signal, async () => URL_FICHA)).rejects.toThrow(/actualicen/);
  });
});

describe('acercar la ficha a un Android (Web NFC)', () => {
  type Reading = { serialNumber: string; message?: { records: Array<{ recordType: string; data?: DataView }> } };
  let next: Reading;
  const written: string[] = [];

  beforeEach(() => {
    written.length = 0;
    class FakeReader {
      onreading: ((e: Reading) => void) | null = null;
      onreadingerror: ((e: Event) => void) | null = null;
      async scan(): Promise<void> {
        setTimeout(() => this.onreading?.(next), 0);
      }
      async write(message: { records: Array<{ data: string }> }): Promise<void> {
        written.push(message.records[0]!.data);
      }
    }
    vi.stubGlobal('window', { NDEFReader: FakeReader });
  });
  afterEach(() => vi.unstubAllGlobals());

  const urlRecord = (url: string) => ({ recordType: 'url', data: new DataView(new TextEncoder().encode(url).buffer) });

  it('en blanco: pide el código y lo graba en la misma ficha', async () => {
    next = { serialNumber: '04:a2:3b:1c', message: { records: [] } };
    const out = await tapChip('web', new AbortController().signal, async () => URL_FICHA);
    expect(out).toEqual({ token: FICHA, uid: '04A23B1C', written: true, other: false });
    expect(written).toEqual([URL_FICHA]);
  });

  it('ya grabada con nuestro enlace: no se graba nada (ni se pide código)', async () => {
    next = { serialNumber: '04:a2:3b:1c', message: { records: [urlRecord(URL_FICHA)] } };
    const blankUrl = vi.fn(async () => URL_FICHA);
    await expect(tapChip('web', new AbortController().signal, blankUrl)).resolves.toMatchObject({ token: FICHA, written: false });
    expect(blankUrl).not.toHaveBeenCalled();
    expect(written).toEqual([]);
  });

  it('con otra cosa grabada: no se toca', async () => {
    next = { serialNumber: '04:a2:3b:1c', message: { records: [urlRecord('https://otra-web.es')] } };
    await expect(tapChip('web', new AbortController().signal, async () => URL_FICHA)).resolves.toMatchObject({ token: null, other: true });
    expect(written).toEqual([]);
  });
});
