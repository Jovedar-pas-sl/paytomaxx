import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReceptionOptions } from '@nightpay/contracts';
import { isSameTapAgain, SAME_TAP_MS } from './prepare-fichas';
import {
  deviceBackend,
  newReceptionKey,
  nextAfterPay,
  payProblem,
  preparedText,
  receptionDetail,
  stockOutcomeLine,
  walletOfTarget,
  type Target,
} from './reception';

const FICHA = 'Kp3vX9qL2mN8rT5wYb7c';
const OPTIONS: ReceptionOptions = { card: true, cash: true, cashBlockedReason: null, nfc: true };
const view = (isHomeVenue = true) => ({ walletId: 'w-1', codeHint: 'K7Q-•••', hasPin: true, isHomeVenue });
const ficha = (uid: string | null, isHomeVenue = true): Target => ({ kind: 'card', card: FICHA, uid, view: view(isHomeVenue) });

describe('pasos de la recepción', () => {
  it('el saldo de la recarga: uno nuevo o el de su ficha (con su número de serie si lo hay)', () => {
    expect(walletOfTarget({ kind: 'new' })).toEqual({ create: true });
    expect(walletOfTarget(ficha('04A2'))).toEqual({ card: FICHA, uid: '04A2' });
    expect(walletOfTarget(ficha(null))).toEqual({ card: FICHA });
  });

  it('cuándo no vale una forma de pago: efectivo sin permiso, tarjeta apagada o saldo de otro local', () => {
    expect(payProblem('cash', { kind: 'new' }, OPTIONS)).toBeNull();
    expect(payProblem('card', ficha('04A2'), OPTIONS)).toBeNull();
    expect(payProblem('cash', { kind: 'new' }, { ...OPTIONS, cash: false, cashBlockedReason: 'Sin permiso' })).toBe('Sin permiso');
    expect(payProblem('cash', { kind: 'new' }, { ...OPTIONS, cash: false })).toMatch(/efectivo/);
    expect(payProblem('card', { kind: 'new' }, { ...OPTIONS, card: false })).toMatch(/tarjeta/);
    expect(payProblem('card', ficha('04A2', false), OPTIONS)).toMatch(/otro local del grupo/);
    // En efectivo sí vale un saldo de otro local del grupo.
    expect(payProblem('cash', ficha('04A2', false), OPTIONS)).toBeNull();
  });

  it('tras cobrar: ficha (si hay fichas y no tiene), luego PIN (si no tiene), luego el resultado', () => {
    const nuevo = { hasCard: false, hasPin: false };
    expect(nextAfterPay(nuevo, { nfc: true })).toBe('chip');
    expect(nextAfterPay(nuevo, { nfc: false })).toBe('pin');
    expect(nextAfterPay({ hasCard: true, hasPin: false }, { nfc: true })).toBe('pin');
    expect(nextAfterPay({ hasCard: true, hasPin: true }, { nfc: true })).toBe('done');
    // A un saldo que ya existía (su ficha) no se le cambia nada.
    expect(nextAfterPay(nuevo, { nfc: true, skipChip: true, skipPin: true })).toBe('done');
  });

  it('el resultado dice el saldo, lo que tiene y si tiene ficha y PIN', () => {
    const w = { walletId: 'w', code: 'K7Q-4M2', balanceCents: 5_000, hasPin: true, hasCard: true };
    expect(receptionDetail(w)).toMatch(/^Saldo K7Q-4M2 · tiene 50,00\s€ · con ficha y PIN$/);
    expect(receptionDetail({ ...w, hasPin: false, hasCard: false })).toMatch(/^Saldo K7Q-4M2 · tiene 50,00\s€$/);
  });

  it('una clave nueva por recarga', () => {
    const a = newReceptionKey();
    expect(a).toMatch(/^rec-/);
    expect(a.length).toBeGreaterThanOrEqual(8);
    expect(newReceptionKey()).not.toBe(a);
  });
});

describe('«Preparar fichas»', () => {
  it('lo que dice cada ficha acercada; solo cuentan las grabadas y las devueltas al stock', () => {
    expect(stockOutcomeLine({ outcome: 'stocked' })).toEqual({ tone: 'ok', text: 'Grabada y en el stock', counts: true });
    expect(stockOutcomeLine({ outcome: 'returned', codeHint: 'K7Q-•••' })).toMatchObject({ counts: true, text: expect.stringContaining('K7Q-•••') });
    expect(stockOutcomeLine({ outcome: 'already' })).toMatchObject({ tone: 'info', counts: false });
    expect(stockOutcomeLine({ outcome: 'in-use', codeHint: 'P9X-•••' })).toMatchObject({ tone: 'warn', counts: false, text: expect.stringContaining('apártala') });
    for (const o of ['lost', 'blocked', 'foreign'] as const) expect(stockOutcomeLine({ outcome: o })).toMatchObject({ tone: 'warn', counts: false });
  });

  it('el contador en palabras', () => {
    expect(preparedText(1)).toBe('1 ficha preparada');
    expect(preparedText(0)).toBe('0 fichas preparadas');
    expect(preparedText(12)).toBe('12 fichas preparadas');
  });

  it('la misma ficha que sigue apoyada no se cuenta dos veces; otra sí', () => {
    const last = { uid: '04A2', at: 1_000 };
    expect(isSameTapAgain(last, '04A2', 1_000 + SAME_TAP_MS - 1)).toBe(true);
    expect(isSameTapAgain(last, '04A2', 1_000 + SAME_TAP_MS)).toBe(false);
    expect(isSameTapAgain(last, '04B3', 1_100)).toBe(false);
    expect(isSameTapAgain(last, null, 1_100)).toBe(false);
    expect(isSameTapAgain(null, '04A2', 1_100)).toBe(false);
  });
});

describe('API de la recepción con la credencial del datáfono', () => {
  const store = new Map<string, string>([['np_pax_device_token', 'cred-del-datafono']]);
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    } as Storage);
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ card: FICHA }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  function sent(i: number): { url: string; method: string; auth: string | null; body: unknown } {
    const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
    return {
      url,
      method: init.method ?? 'GET',
      auth: new Headers(init.headers).get('Authorization'),
      body: init.body ? JSON.parse(String(init.body)) : null,
    };
  }

  it('cada llamada va con Authorization: Device y a /v1/pos-device/reception', async () => {
    const w = { walletId: 'w-1', code: 'K7Q-4M2', balanceCents: 0, hasPin: false, hasCard: false };
    await deviceBackend.options();
    await deviceBackend.lookup(FICHA, '04A2');
    await deviceBackend.cash({ amountCents: 5_000, idempotencyKey: 'rec-12345678', wallet: { create: true } });
    await deviceBackend.cardSale({ amountCents: 5_000, idempotencyKey: 'rec-12345678', wallet: { card: FICHA } });
    await deviceBackend.wallet('w-1');
    await deviceBackend.link(w, FICHA, null);
    await deviceBackend.setPin(w, '4827');
    await expect(deviceBackend.newToken()).resolves.toBe(FICHA);
    await deviceBackend.stock(FICHA, '04A2');
    const urls = fetchMock.mock.calls.map((c) => String(c[0]).replace(/^https?:\/\/[^/]+/, ''));
    expect(urls).toEqual([
      '/v1/pos-device/reception/options',
      '/v1/pos-device/reception/lookup',
      '/v1/pos-device/reception/cash',
      '/v1/pos-device/reception/card',
      '/v1/pos-device/reception/wallets/w-1',
      '/v1/pos-device/reception/wallets/w-1/card',
      '/v1/pos-device/reception/wallets/w-1/pin',
      '/v1/pos-device/reception/fichas/token',
      '/v1/pos-device/reception/fichas/stock',
    ]);
    expect(sent(0)).toMatchObject({ method: 'GET', auth: 'Device cred-del-datafono' });
    expect(sent(1).body).toEqual({ card: FICHA, uid: '04A2' });
    expect(sent(2).body).toEqual({ amountCents: 5_000, idempotencyKey: 'rec-12345678', wallet: { create: true } });
    expect(sent(5).body).toEqual({ card: FICHA });
    expect(sent(6).body).toEqual({ pin: '4827' });
  });
});
