import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blankCodeFrom, ChipError, isChipTimeout, isFatalChipError, noPhoneNfcNote, tapChip, tapFromBridge } from './chip-tap';

const FICHA = 'Kp3vX9qL2mN8rT5wYb7c';
const URL_FICHA = `https://operator.x/?ficha=${FICHA}`;
const toUrl = (token: string) => `https://operator.x/?ficha=${token}`;

/** Un código para fichas en blanco que cuenta cuántas veces se pidió al servidor. */
function code(token = FICHA) {
  const newToken = vi.fn(async () => token);
  return { blank: blankCodeFrom(newToken, toUrl), newToken };
}

describe('el código para la próxima ficha en blanco', () => {
  it('se pide una vez y se reutiliza hasta que se intenta grabar', async () => {
    const { blank, newToken } = code();
    await expect(blank.url()).resolves.toBe(URL_FICHA);
    await blank.url();
    expect(newToken).toHaveBeenCalledTimes(1);
    blank.spent();
    await blank.url();
    expect(newToken).toHaveBeenCalledTimes(2);
  });

  it('si la petición falla, el siguiente intento pide otro', async () => {
    const newToken = vi.fn().mockRejectedValueOnce(new Error('sin red')).mockResolvedValue(FICHA);
    const blank = blankCodeFrom(newToken, toUrl);
    await expect(blank.url()).rejects.toThrow('sin red');
    await expect(blank.url()).resolves.toBe(URL_FICHA);
  });
});

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
    const { blank, newToken } = code();
    await expect(tapChip('bridge', new AbortController().signal, blank)).resolves.toMatchObject({ token: FICHA, written: true });
    expect(newToken).toHaveBeenCalledTimes(1);
    expect(calls[0]).toEqual(['writeNfc', expect.objectContaining({ url: URL_FICHA, onlyIfBlank: true, timeoutMs: 60_000 })]);
    // Grabado: la siguiente ficha lleva otro código.
    await blank.url();
    expect(newToken).toHaveBeenCalledTimes(2);
  });

  it('la app dice «no se grabó» (tenía algo): el código sirve para la siguiente', async () => {
    answer('writeNfc', () => ({ ok: true, uid: '04A23B1C', url: 'https://otra-web.es', written: false }));
    const { blank, newToken } = code();
    await expect(tapChip('bridge', new AbortController().signal, blank)).resolves.toMatchObject({ other: true });
    await blank.url();
    expect(newToken).toHaveBeenCalledTimes(1);
  });

  it('sin saber cómo acabó (tiempo agotado, error): el código no se reutiliza', async () => {
    answer('writeNfc', () => ({ ok: false, error: 'timeout' }));
    const { blank, newToken } = code();
    await expect(tapChip('bridge', new AbortController().signal, blank)).rejects.toMatchObject({ code: 'timeout' });
    await blank.url();
    expect(newToken).toHaveBeenCalledTimes(2);
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
    const tapping = tapChip('bridge', controller.signal, code().blank);
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    await expect(tapping).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls.map(([m]) => m)).toEqual(['writeNfc', 'cancelRead']);
  });

  it('una app del datáfono vieja sin writeNfc: se dice que hay que actualizarla', async () => {
    await expect(tapChip('bridge', new AbortController().signal, code().blank)).rejects.toThrow(/actualicen/);
  });
});

describe('acercar la ficha a un Android (Web NFC)', () => {
  type Reading = { serialNumber: string; message?: { records: Array<{ recordType: string; data?: DataView }> } };
  let next: Reading;
  /** Lo que Chrome lee tras grabar (null: no vuelve a leerla). */
  let afterWrite: Reading | null;
  const written: Array<{ url: string; overwrite: boolean | undefined }> = [];

  beforeEach(() => {
    written.length = 0;
    afterWrite = null;
    class FakeReader {
      onreading: ((e: Reading) => void) | null = null;
      onreadingerror: ((e: Event) => void) | null = null;
      async scan(): Promise<void> {
        setTimeout(() => this.onreading?.(next), 0);
      }
      async write(message: { records: Array<{ data: string }> }, options?: { overwrite?: boolean }): Promise<void> {
        written.push({ url: message.records[0]!.data, overwrite: options?.overwrite });
        const again = afterWrite;
        if (again) setTimeout(() => this.onreading?.(again), 0);
      }
    }
    vi.stubGlobal('window', { NDEFReader: FakeReader });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const urlRecord = (url: string) => ({ recordType: 'url', data: new DataView(new TextEncoder().encode(url).buffer) });

  it('en blanco: el código se pide antes, se graba sin pisar nada y vale la ficha que quedó grabada', async () => {
    next = { serialNumber: '04:a2:3b:1c', message: { records: [] } };
    // La cambiaron por otra en blanco entre leer y grabar: vale el número de serie de la grabada.
    afterWrite = { serialNumber: '04:99:88:77', message: { records: [urlRecord(URL_FICHA)] } };
    const { blank, newToken } = code();
    const out = await tapChip('web', new AbortController().signal, blank);
    expect(out).toEqual({ token: FICHA, uid: '04998877', written: true, other: false });
    expect(written).toEqual([{ url: URL_FICHA, overwrite: false }]);
    await blank.url();
    expect(newToken).toHaveBeenCalledTimes(2);
  });

  it('grabada pero sin poder comprobarla: error, y el código no se reutiliza', async () => {
    vi.useFakeTimers();
    next = { serialNumber: '04:a2:3b:1c', message: { records: [] } };
    const { blank, newToken } = code();
    const tapping = tapChip('web', new AbortController().signal, blank);
    const failed = expect(tapping).rejects.toMatchObject({ code: 'unverified' });
    await vi.runAllTimersAsync();
    await failed;
    await blank.url();
    expect(newToken).toHaveBeenCalledTimes(2);
  });

  it('ya grabada con nuestro enlace: no se graba nada (y el código pedido sirve para otra)', async () => {
    next = { serialNumber: '04:a2:3b:1c', message: { records: [urlRecord(URL_FICHA)] } };
    const { blank, newToken } = code('OtroCodigoParaLaSiguiente');
    await expect(tapChip('web', new AbortController().signal, blank)).resolves.toMatchObject({ token: FICHA, written: false });
    expect(written).toEqual([]);
    await blank.url();
    expect(newToken).toHaveBeenCalledTimes(1);
  });

  it('con otra cosa grabada: no se toca', async () => {
    next = { serialNumber: '04:a2:3b:1c', message: { records: [urlRecord('https://otra-web.es')] } };
    await expect(tapChip('web', new AbortController().signal, code().blank)).resolves.toMatchObject({ token: null, other: true });
    expect(written).toEqual([]);
  });
});

describe('móvil sin NFC (iPhone…)', () => {
  it('pide un Android con Chrome; el datáfono, solo si el local cobra con él', () => {
    expect(noPhoneNfcNote(true)).toBe('Este móvil no lee fichas desde la app: hace falta un Android con Chrome (o el datáfono).');
    expect(noPhoneNfcNote(false)).toBe('Este móvil no lee fichas desde la app: hace falta un Android con Chrome.');
  });
});
