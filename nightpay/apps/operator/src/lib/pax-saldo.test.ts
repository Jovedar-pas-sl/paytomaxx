import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaxApiError } from './pax-api';
import {
  checkProblem,
  checkSaldoWallet,
  classifyPinError,
  fetchSaldoCharge,
  fichaFromBridge,
  outcomeOf,
  parseScan,
  paySaldoWithPin,
  readerErrorText,
  readFicha,
  refBody,
  refLabel,
  scanSaldoCharge,
  scanWithCamera,
  submitPin,
  type SaldoCheck,
} from './pax-saldo';

const PAY_TOKEN = 'Qm9sYS1kZS1jb2Jyby1kZS1wcnVlYmE';
const WALLET_TOKEN = 'cGFzZS1kZWwtc2FsZG8tMDE';
const FICHA = 'Kp3vX9qL2mN8rT5wYb7c';

describe('parseScan: qué QR ha leído el datáfono', () => {
  it('el QR del cobro de la chica (/s/<token>)', () => {
    expect(parseScan(`https://api.paytomaxx.com/s/${PAY_TOKEN}`)).toEqual({ kind: 'charge', payToken: PAY_TOKEN });
    expect(parseScan(`  https://api.paytomaxx.com/s/${PAY_TOKEN}/ `)).toEqual({ kind: 'charge', payToken: PAY_TOKEN });
  });

  it('el pase de Google Wallet (/w/<token>), la página del saldo (?saldo=) y el código suelto', () => {
    expect(parseScan(`https://api.paytomaxx.com/w/${WALLET_TOKEN}`)).toEqual({
      kind: 'wallet',
      ref: { walletToken: WALLET_TOKEN },
    });
    expect(parseScan('https://operator.paytomaxx.com/?saldo=K7Q4M2')).toEqual({ kind: 'wallet', ref: { code: 'K7Q4M2' } });
    expect(parseScan('k7q-4m2')).toEqual({ kind: 'wallet', ref: { code: 'K7Q4M2' } });
  });

  it('el enlace de una ficha pasado a QR: su código, sin número de serie (el PIN sigue haciendo falta)', () => {
    expect(parseScan(`https://operator.paytomaxx.com/?ficha=${FICHA}`)).toEqual({
      kind: 'wallet',
      ref: { card: FICHA, uid: null },
    });
  });

  it('lo demás no vale: otra ruta, tokens raros, otros esquemas, textos largos', () => {
    expect(parseScan('')).toEqual({ kind: 'unknown' });
    expect(parseScan('https://api.paytomaxx.com/s/corto')).toEqual({ kind: 'unknown' });
    expect(parseScan(`https://api.paytomaxx.com/x/s/${PAY_TOKEN}`)).toEqual({ kind: 'unknown' });
    expect(parseScan(`https://api.paytomaxx.com/s/${PAY_TOKEN}/pay`)).toEqual({ kind: 'unknown' });
    expect(parseScan(`javascript:alert(1)//s/${PAY_TOKEN}`)).toEqual({ kind: 'unknown' });
    expect(parseScan('https://operator.paytomaxx.com/?saldo=K7Q')).toEqual({ kind: 'unknown' });
    expect(parseScan('Hola, esto es un QR de una carta')).toEqual({ kind: 'unknown' });
    expect(parseScan(`https://x.es/s/${PAY_TOKEN}?${'a'.repeat(3000)}`)).toEqual({ kind: 'unknown' });
  });
});

describe('antes del PIN', () => {
  const ok: SaldoCheck = { codeHint: 'K7Q-•••', hasPin: true, pinLocked: false, pinByStaff: false, enough: true };

  it('con PIN, sin bloquear y con saldo: que lo teclee', () => {
    expect(checkProblem(ok)).toBeNull();
  });

  it('dice por qué no, empezando por lo que el cliente no puede arreglar aquí', () => {
    expect(checkProblem({ ...ok, pinLocked: true, enough: false })).toMatch(/bloqueado/);
    expect(checkProblem({ ...ok, hasPin: false })).toMatch(/no tiene PIN/);
    expect(checkProblem({ ...ok, pinByStaff: true })).toMatch(/app del personal/);
    expect(checkProblem({ ...ok, enough: false })).toMatch(/No le llega/);
  });

  it('cómo se leyó el saldo, con el código a medias', () => {
    expect(refLabel({ card: FICHA, uid: null }, 'K7Q-•••')).toBe('Ficha · K7Q-•••');
    expect(refLabel({ walletToken: WALLET_TOKEN }, 'K7Q-•••')).toBe('Pase · K7Q-•••');
    expect(refLabel({ code: 'K7Q4M2' }, 'K7Q-•••')).toBe('Código · K7Q-•••');
  });
});

describe('tras el PIN', () => {
  it('PIN mal o demasiados intentos: se queda en el teclado', () => {
    expect(classifyPinError(new PaxApiError('PIN incorrecto. Quedan 3 intentos', 422))).toBe('retry');
    expect(classifyPinError(new PaxApiError('Demasiadas peticiones', 429))).toBe('retry');
  });

  it('sin respuesta o error del servidor: no se sabe, se pregunta por el cobro', () => {
    expect(classifyPinError(new PaxApiError('Sin conexión', 0))).toBe('uncertain');
    expect(classifyPinError(new PaxApiError('Internal', 500))).toBe('uncertain');
    expect(classifyPinError(new Error('raro'))).toBe('uncertain');
  });

  it('bloqueado, retirado, de otro local o PIN del personal: se acaba', () => {
    expect(classifyPinError(new PaxApiError('PIN incorrecto. Saldo bloqueado: avisa al encargado', 422))).toBe('stop');
    expect(classifyPinError(new PaxApiError('Este cobro ya no está pendiente', 409))).toBe('stop');
    expect(classifyPinError(new PaxApiError('Cobro no encontrado', 404))).toBe('stop');
    expect(classifyPinError(new PaxApiError('Este PIN lo puso el personal', 403))).toBe('stop');
    expect(classifyPinError(new PaxApiError('Local en pausa', 423))).toBe('stop');
  });

  it('estado del cobro → pantalla de resultado', () => {
    expect(outcomeOf('PENDING')).toBeNull();
    expect(outcomeOf('ACCEPTED')).toBe('paid');
    expect(outcomeOf('EXPIRED')).toBe('expired');
    expect(outcomeOf('CANCELED')).toBe('failed');
    expect(outcomeOf('REJECTED')).toBe('failed');
  });
});

describe('lectores del datáfono', () => {
  it('la ficha leída por la app: su código del enlace NDEF y el número de serie normalizado', () => {
    expect(
      fichaFromBridge({ ok: true, uid: '04:a2:3b:1c:2d:5e:80', url: `https://operator.paytomaxx.com/?ficha=${FICHA}` }),
    ).toEqual({ token: FICHA, uid: '04A23B1C2D5E80' });
    expect(fichaFromBridge({ ok: true, uid: '04A23B1C', url: null })).toEqual({ token: null, uid: '04A23B1C' });
    expect(fichaFromBridge({ ok: true, uid: null, url: 'https://otra.cosa/menu' })).toEqual({ token: null, uid: null });
  });

  it('cancelar es un AbortError; el NFC reservado por el datáfono se explica', () => {
    expect(() => fichaFromBridge({ ok: false, error: 'cancelled' })).toThrow(expect.objectContaining({ name: 'AbortError' }));
    expect(() => fichaFromBridge({ ok: false, error: 'nfcUnavailable' })).toThrow(/no deja leer fichas/);
    expect(readerErrorText('loQueSea', 'Texto de la app')).toBe('Texto de la app');
    expect(readerErrorText('loQueSea')).toBe('Error del lector.');
  });

  it('el cuerpo de la petición: la ficha sin número de serie no lo manda', () => {
    expect(refBody({ card: FICHA, uid: null })).toEqual({ card: FICHA });
    expect(refBody({ card: FICHA, uid: '04A2' })).toEqual({ card: FICHA, uid: '04A2' });
    expect(refBody({ walletToken: WALLET_TOKEN })).toEqual({ walletToken: WALLET_TOKEN });
    expect(refBody({ code: 'K7Q4M2' })).toEqual({ code: 'K7Q4M2' });
  });
});

describe('puente con la app del datáfono (scanQr, readNfc, cancelRead)', () => {
  type Win = {
    NightPayPax?: Record<string, (json: string) => void>;
    nightpayPaxCallback?: (requestId: string, json: string) => void;
  };
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

  it('scanQr: el texto del QR; cancelado → null; sin cámara → su texto', async () => {
    answer('scanQr', () => ({ ok: true, text: `https://api.x/s/${PAY_TOKEN}` }));
    await expect(scanWithCamera()).resolves.toBe(`https://api.x/s/${PAY_TOKEN}`);
    expect(calls[0]![1]).toMatchObject({ timeoutMs: 90_000 });
    answer('scanQr', () => ({ ok: false, error: 'cancelled' }));
    await expect(scanWithCamera()).resolves.toBeNull();
    answer('scanQr', () => ({ ok: false, error: 'permissionDenied' }));
    await expect(scanWithCamera()).rejects.toThrow(/permiso para la cámara/);
  });

  it('una app vieja sin scanQr: se dice que hay que actualizarla (no se queda esperando)', async () => {
    await expect(scanWithCamera()).rejects.toThrow(/actualicen/);
  });

  it('readNfc por la app; al cancelar en la pantalla se avisa a la app (cancelRead)', async () => {
    answer('readNfc', () => ({ ok: true, uid: '04A23B1C2D5E80', url: `https://operator.x/?ficha=${FICHA}` }));
    await expect(readFicha(new AbortController().signal, 'bridge')).resolves.toEqual({ token: FICHA, uid: '04A23B1C2D5E80' });

    let pendingId = '';
    answer('readNfc', (req) => {
      pendingId = String(req.requestId);
      return null; // espera una ficha que no llega
    });
    answer('cancelRead', () => {
      setTimeout(() => win.nightpayPaxCallback?.(pendingId, JSON.stringify({ ok: false, error: 'cancelled' })), 0);
      return { ok: true };
    });
    const controller = new AbortController();
    const reading = readFicha(controller.signal, 'bridge');
    controller.abort();
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls.map(([m]) => m)).toEqual(['readNfc', 'readNfc', 'cancelRead']);
  });
});

describe('API del saldo con la credencial del datáfono', () => {
  const store = new Map<string, string>([['np_pax_device_token', 'cred-del-datafono']]);
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    } as Storage);
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  function sent(i = 0): { url: string; method: string; auth: string | null; body: unknown } {
    const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
    const headers = new Headers(init.headers);
    return {
      url,
      method: init.method ?? 'GET',
      auth: headers.get('Authorization'),
      body: init.body ? JSON.parse(String(init.body)) : null,
    };
  }

  it('cada llamada va con Authorization: Device y a las rutas /saldo del datáfono', async () => {
    await scanSaldoCharge(PAY_TOKEN);
    await checkSaldoWallet('c-1', { card: FICHA, uid: '04A2' });
    await paySaldoWithPin('c-1', { code: 'K7Q4M2' }, '4827');
    await fetchSaldoCharge('c-1');
    expect(sent(0)).toMatchObject({
      method: 'POST',
      auth: 'Device cred-del-datafono',
      body: { payToken: PAY_TOKEN },
    });
    expect(sent(0).url).toMatch(/\/v1\/pos-device\/saldo\/charges\/scan$/);
    expect(sent(1)).toMatchObject({ body: { card: FICHA, uid: '04A2' } });
    expect(sent(1).url).toMatch(/\/saldo\/charges\/c-1\/check$/);
    expect(sent(2)).toMatchObject({ body: { code: 'K7Q4M2', pin: '4827' } });
    expect(sent(3)).toMatchObject({ method: 'GET', auth: 'Device cred-del-datafono' });
    expect(sent(3).url).toMatch(/\/saldo\/charges\/c-1$/);
  });

  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const view = (status: string, newBalanceCents: number | null = null) => ({
    id: 'c-1',
    status,
    amountCents: 4_000,
    serviceName: null,
    expiresAt: '2026-10-17T00:00:00Z',
    newBalanceCents,
  });
  const byCode = { code: 'K7Q4M2' };

  it('submitPin: pagado → PAGADO con lo que le queda; PIN mal → se queda en el teclado', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, view('ACCEPTED', 8_000)));
    await expect(submitPin('c-1', byCode, '4827')).resolves.toEqual({ kind: 'done', outcome: 'paid', newBalanceCents: 8_000 });
    fetchMock.mockResolvedValueOnce(reply(422, { detail: 'PIN incorrecto. Quedan 2 intentos' }));
    await expect(submitPin('c-1', byCode, '1111')).resolves.toEqual({ kind: 'retry', message: 'PIN incorrecto. Quedan 2 intentos' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('submitPin tras un corte: manda el estado del cobro (pagado → PAGADO, pendiente → repetir el PIN)', async () => {
    fetchMock.mockResolvedValueOnce(reply(502, {})).mockResolvedValueOnce(reply(200, view('ACCEPTED')));
    await expect(submitPin('c-1', byCode, '4827')).resolves.toEqual({ kind: 'done', outcome: 'paid', newBalanceCents: null });
    expect(sent(1)).toMatchObject({ method: 'GET' });

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(reply(200, view('PENDING')));
    await expect(submitPin('c-1', byCode, '4827')).resolves.toEqual({ kind: 'retry', message: 'No se ha cobrado: vuelve a poner el PIN.' });

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(submitPin('c-1', byCode, '4827')).resolves.toMatchObject({ kind: 'retry', message: expect.stringMatching(/nunca se cobra dos veces/) });
  });

  it('submitPin con un cobro que ya no se puede pagar: el resultado según cómo acabó', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(409, { detail: 'Este cobro ya no está pendiente' }))
      .mockResolvedValueOnce(reply(200, view('CANCELED')));
    await expect(submitPin('c-1', byCode, '4827')).resolves.toEqual({
      kind: 'done',
      outcome: 'failed',
      newBalanceCents: null,
      message: 'Este cobro ya no está pendiente',
    });
    fetchMock
      .mockResolvedValueOnce(reply(409, { detail: 'Este cobro ha caducado' }))
      .mockResolvedValueOnce(reply(200, view('EXPIRED')));
    await expect(submitPin('c-1', byCode, '4827')).resolves.toMatchObject({ kind: 'done', outcome: 'expired' });
    fetchMock
      .mockResolvedValueOnce(reply(422, { detail: 'PIN incorrecto. Saldo bloqueado: avisa al encargado' }))
      .mockResolvedValueOnce(reply(200, view('PENDING')));
    await expect(submitPin('c-1', byCode, '1111')).resolves.toMatchObject({
      kind: 'done',
      outcome: 'failed',
      message: expect.stringMatching(/bloqueado/),
    });
  });

  it('un error del API llega con su código (para saber si repetir el PIN)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: 'PIN incorrecto. Quedan 4 intentos' }), { status: 422 }),
    );
    const err = await paySaldoWithPin('c-1', { code: 'K7Q4M2' }, '1111').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaxApiError);
    expect(err).toMatchObject({ status: 422, message: 'PIN incorrecto. Quedan 4 intentos' });
    expect(classifyPinError(err)).toBe('retry');
  });
});
