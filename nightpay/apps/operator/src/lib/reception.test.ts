import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReceptionOptions } from '@nightpay/contracts';
import { isSameTapAgain, SAME_TAP_MS } from './prepare-fichas';
import {
  cardMethodLabel,
  deviceBackend,
  existingTopUpDetail,
  newReceptionKey,
  nextAfterPay,
  payProblem,
  preparedText,
  receptionAttempt,
  receptionDetail,
  receptionWhat,
  stockOutcomeLine,
  topUpCheck,
  walletAfterCash,
  walletOfTarget,
  type ReceptionTopUpView,
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
  });

  it('la tarjeta en el móvil del personal: el cliente paga en su móvil (sin datáfono); en el datáfono, su lector', () => {
    expect(cardMethodLabel('staff')).toBe('Tarjeta / Apple Pay / Google Pay (en su móvil)');
    expect(cardMethodLabel('staff')).not.toMatch(/datáfono/i);
    expect(cardMethodLabel('device')).toBe('Tarjeta (en este datáfono)');
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

  it('«Recargar saldo» por su código: el código en la petición, en la clave y en la pantalla', () => {
    const porCodigo: Target = { kind: 'code', code: 'K7Q-4M2', view: view(false) };
    expect(walletOfTarget(porCodigo)).toEqual({ code: 'K7Q-4M2' });
    expect(receptionWhat(5_000, 'cash', porCodigo)).toBe('5000|cash|codigo:K7Q-4M2');
    expect(receptionWhat(5_000, 'cash', ficha('04A2'))).toBe(`5000|cash|ficha:${FICHA}`);
    // Con tarjeta solo se recarga en su local (también por código).
    expect(payProblem('card', porCodigo, OPTIONS)).toMatch(/otro local del grupo/);
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

describe('la clave de la recarga va con lo que se recarga', () => {
  it('lo mismo otra vez (corte, doble toque): la misma clave', () => {
    const first = receptionAttempt(null, receptionWhat(5_000, 'cash', { kind: 'new' }));
    expect(receptionAttempt(first, receptionWhat(5_000, 'cash', { kind: 'new' }))).toBe(first);
  });

  it('otro saldo, otro importe u otra forma de pago: clave nueva', () => {
    const first = receptionAttempt(null, receptionWhat(5_000, 'cash', { kind: 'new' }));
    const toCard = receptionAttempt(first, receptionWhat(5_000, 'cash', ficha('04A2')));
    expect(toCard.key).not.toBe(first.key);
    expect(receptionAttempt(first, receptionWhat(6_000, 'cash', { kind: 'new' })).key).not.toBe(first.key);
    expect(receptionAttempt(first, receptionWhat(5_000, 'card', { kind: 'new' })).key).not.toBe(first.key);
  });
});

describe('recarga de una ficha que ya tenía saldo', () => {
  it('en efectivo: el resultado sale de lo que devolvió el cobro', () => {
    const wallet = walletAfterCash({ walletId: 'w-1', code: 'K7Q-4M2', balanceCents: 8_000 }, view());
    expect(wallet).toEqual({ walletId: 'w-1', code: 'K7Q-4M2', balanceCents: 8_000, hasPin: true, hasCard: true });
    expect(receptionDetail(wallet)).toMatch(/^Saldo K7Q-4M2 · tiene 80,00\s€ · con ficha y PIN$/);
  });

  it('con tarjeta: su ficha, sin pedir el saldo', () => {
    expect(existingTopUpDetail(view())).toBe('Saldo K7Q-••• · con ficha y PIN');
    expect(existingTopUpDetail({ ...view(), hasPin: false })).toBe('Saldo K7Q-••• · con ficha');
  });
});

describe('cómo quedó la recarga con tarjeta de una ficha que ya tenía saldo', () => {
  const view = (over: Partial<ReceptionTopUpView> = {}): ReceptionTopUpView => ({
    paymentId: 'p-1',
    status: 'CREDITED',
    amountCents: 5_000,
    walletId: 'w-1',
    codeHint: 'K7Q-•••',
    balanceCents: 8_000,
    hasPin: true,
    hasCard: true,
    ...over,
  });

  it('sumada: el saldo que tiene ahora', () => {
    const check = topUpCheck(view());
    expect(check.kind).toBe('done');
    expect(check.kind === 'done' && check.detail).toMatch(/^Saldo K7Q-••• · tiene 80,00\s€ · con ficha y PIN$/);
    expect(topUpCheck(view({ balanceCents: null, hasPin: false }))).toEqual({ kind: 'done', detail: 'Saldo K7Q-••• · con ficha' });
  });

  it('pendiente de Paytef, no cobrada o aún abierta', () => {
    expect(topUpCheck(view({ status: 'PENDING' }))).toEqual({ kind: 'pending' });
    expect(topUpCheck(view({ status: 'NOT_PAID' }))).toEqual({ kind: 'notPaid' });
    expect(topUpCheck(view({ status: 'OPEN' }))).toEqual({ kind: 'wait' });
  });

  it('se pregunta en el datáfono por su recarga', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(view()), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(deviceBackend.topUp('p 1')).resolves.toMatchObject({ status: 'CREDITED' });
      expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toMatch(/\/v1\/pos-device\/reception\/topups\/p%201$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
