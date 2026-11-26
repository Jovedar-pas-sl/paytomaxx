// El simulador del «Modo práctica»: contesta en memoria a lo que usan los
// flujos que se ensayan (cobrar en barra, pagar con ficha y PIN, recargar en
// recepción). Respuestas fijas y con la forma del API real (@nightpay/contracts):
// las pantallas de verdad no notan la diferencia. Nada sale del móvil.

import { PIN_REQUIRED_CODE, type CashTopUpResult, type PaymentStatus, type ReceptionDeskSaldo } from '@nightpay/contracts';
import type { CobroCreado, SaldoCobro, SaldoState } from './api-cobro';
import type { PolledPayment } from './payment-status';
import { PRACTICE_ID_PREFIX, PRACTICE_QR_TEXT, PracticeBlockedError, setPractice } from './practice';

/** El PIN que vale en práctica; cualquier otro, el camino de PIN mal. */
export const PRACTICE_PIN = '1234';
/** El saldo falso de la ficha de práctica. */
export const PRACTICE_BALANCE_CENTS = 5000;
const PRACTICE_CARD = `${PRACTICE_ID_PREFIX}FICHA`;
const PRACTICE_UID = `${PRACTICE_ID_PREFIX}UID`;
/** El código del saldo de práctica (el que sale en recepción y en el PIN). */
export const PRACTICE_CODE = 'PRA-CTI';
const PRACTICE_WALLET_ID = `${PRACTICE_ID_PREFIX}WALLET`;
const QR_MS = 5 * 60_000;

/** La ficha que acerca «Simular ficha». */
export const PRACTICE_TAP = { token: PRACTICE_CARD, uid: PRACTICE_UID } as const;

interface SimPayment {
  id: string;
  qrToken: string;
  status: PaymentStatus;
  amountCents: number;
}
interface SimCharge {
  id: string;
  status: SaldoState['status'];
  amountCents: number;
  newBalanceCents: number | null;
  paymentId: string | null;
}

let counter = 0;
let nextAmount: number | null = null;
let payments = new Map<string, SimPayment>();
let charges = new Map<string, SimCharge>();
let wallet = PRACTICE_BALANCE_CENTS;

/** Vuelve todo a cero (al salir de la práctica y en los tests). */
export function resetPracticeSim(): void {
  counter = 0;
  nextAmount = null;
  payments = new Map();
  charges = new Map();
  wallet = PRACTICE_BALANCE_CENTS;
}

/** El importe que la pantalla ya conoce del próximo cobro (las líneas de la carta no llevan precio). */
export function setPracticeNextAmount(cents: number): void {
  nextAmount = cents;
}

const newId = (kind: string): string => `${PRACTICE_ID_PREFIX}${kind}-${String((counter += 1)).padStart(4, '0')}`;
const iso = (ms = 0): string => new Date(Date.now() + ms).toISOString();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
const problem = (status: number, detail: string, code?: string, reason?: string): Response =>
  json(status, { detail, ...(code ? { code } : {}), ...(reason ? { reason } : {}) });

const sameCode = (a: string, b: string): boolean => a.replace(/[^a-z0-9]/gi, '').toUpperCase() === b.replace(/[^a-z0-9]/gi, '').toUpperCase();

/**
 * ¿Es la ficha o el código de práctica? Una ficha, un código o un pase de
 * verdad, no: el simulador no les contesta como si fueran el de práctica (una
 * ficha real daba «Cargado» y el cliente se iba sin saldo). Sin ninguno (una
 * ficha nueva sin leer), nada de verdad que tocar.
 */
function isPracticeRef(ref: unknown): boolean {
  if (!ref || typeof ref !== 'object') return true;
  const r = ref as { card?: unknown; code?: unknown; walletToken?: unknown };
  if (typeof r.card === 'string') return r.card === PRACTICE_CARD;
  if (typeof r.code === 'string') return sameCode(r.code, PRACTICE_CODE);
  return r.walletToken === undefined;
}
const notPractice = (): Response => problem(422, 'Esta ficha no es de práctica: usa «Simular ficha».');

// ─── Tiempo real de mentira: lo que el simulador «avisa» a las pantallas ───

type Listener = (event: unknown) => void;
const bus = new Map<string, Set<Listener>>();

function emit(event: string, payload: unknown): void {
  for (const listener of bus.get(event) ?? []) listener(payload);
}

/**
 * Un socket que nunca conecta: ninguna escucha del servidor real (un cobro de
 * verdad no sale en práctica) y solo oye lo que dice el simulador.
 */
export function practiceSocket() {
  const mine: Array<[string, Listener]> = [];
  const socket = {
    active: false as const,
    on(event: string, listener: Listener) {
      if (!bus.has(event)) bus.set(event, new Set());
      bus.get(event)!.add(listener);
      mine.push([event, listener]);
      return socket;
    },
    emit: () => socket,
    connect: () => socket,
    disconnect() {
      for (const [event, listener] of mine) bus.get(event)?.delete(listener);
      mine.length = 0;
      return socket;
    },
  };
  return socket;
}

// ─── Lo que hace el botón «Simular» ────────────────────────────────────────

/** «El cliente paga» (`paid`) o «no paga» (`fail`) en el cobro de práctica abierto. */
export function finishPracticeCobro(target: { paymentId?: string | null; chargeId?: string | null }, result: 'paid' | 'fail'): void {
  const payment = target.paymentId ? payments.get(target.paymentId) : undefined;
  const charge = target.chargeId ? charges.get(target.chargeId) : undefined;
  if (payment) {
    payment.status = result === 'paid' ? 'AUTHORIZED' : 'FAILED';
    if (result === 'paid') emit('payment:completed', { paymentId: payment.id, status: payment.status, tipCents: 0 });
    else emit('payment:update', { paymentId: payment.id, status: payment.status });
  }
  if (charge) {
    // Con tarjeta, el saldo queda cancelado (como hace el servidor); sin ella, paga o caduca.
    charge.status = payment ? 'CANCELED' : result === 'paid' ? 'ACCEPTED' : 'EXPIRED';
    if (charge.status === 'ACCEPTED') {
      charge.newBalanceCents = wallet - charge.amountCents;
      wallet = charge.newBalanceCents;
    }
    emit('wallet-charge:update', { id: charge.id, status: charge.status });
  }
}

// ─── Las respuestas ────────────────────────────────────────────────────────

/** El importe del cobro: el que dice la pantalla, el tecleado o la suma de las líneas con precio. */
function amountOf(body: Record<string, unknown>): number {
  const lines = Array.isArray(body.lines) ? (body.lines as Array<{ amountCents?: number; qty?: number }>) : [];
  const fromLines = lines.reduce((sum, l) => sum + (l.amountCents ?? 0) * (l.qty ?? 1), 0);
  const cents = typeof body.amountCents === 'number' ? body.amountCents : (nextAmount ?? (fromLines || 1000));
  nextAmount = null;
  return cents;
}

function createPayment(body: Record<string, unknown>): Response {
  if (!isPracticeRef(body.wallet)) return notPractice();
  const amountCents = amountOf(body);
  const id = newId('PAGO');
  let saldo: CobroCreado['saldo'] = null;
  if (body.withSaldo === true) {
    const chargeId = newId('SALDO');
    charges.set(chargeId, { id: chargeId, status: 'PENDING', amountCents, newBalanceCents: null, paymentId: id });
    saldo = { chargeId, expiresAt: iso(QR_MS) };
  }
  const qrToken = `${PRACTICE_ID_PREFIX}QR-${counter}`;
  payments.set(id, { id, qrToken, status: 'CREATED', amountCents });
  const created: CobroCreado = {
    id,
    amountCents,
    currency: 'EUR',
    status: 'CREATED',
    qrToken,
    // Texto plano, no un enlace: ninguna cámara abre nada con este QR.
    qrUrl: PRACTICE_QR_TEXT,
    qrPngDataUrl: '',
    qrExpiresAt: iso(QR_MS),
    createdAt: iso(),
    ref: `${PRACTICE_ID_PREFIX}${counter}`,
    ...(typeof body.wallet === 'object' && body.wallet !== null ? { walletId: PRACTICE_WALLET_ID } : {}),
    saldo,
  };
  return json(201, created);
}

function createSaldo(body: Record<string, unknown>): Response {
  const id = newId('SALDO');
  const amountCents = amountOf(body);
  charges.set(id, { id, status: 'PENDING', amountCents, newBalanceCents: null, paymentId: null });
  const out: SaldoCobro = {
    id,
    ref: `${PRACTICE_ID_PREFIX}${counter}`,
    status: 'PENDING',
    amountCents,
    expiresAt: iso(QR_MS),
    payUrl: PRACTICE_QR_TEXT,
    qrPngDataUrl: '',
  };
  return json(201, out);
}

function saldoState(c: SimCharge): SaldoState {
  return {
    id: c.id,
    ref: null,
    status: c.status,
    amountCents: c.amountCents,
    tipCents: 0,
    newBalanceCents: c.newBalanceCents,
    ...(c.status === 'ACCEPTED' ? { paidWith: 'pin' as const, walletCodeHint: 'PRA-•••' } : {}),
  };
}

const lookup = () => ({
  walletId: PRACTICE_WALLET_ID,
  code: PRACTICE_CODE,
  balanceCents: wallet,
  label: null,
  homeVenueName: 'Práctica',
  hasPin: true,
  pinLocked: false,
  hasCard: true,
});

function deskView(): ReceptionDeskSaldo {
  return {
    kind: 'saldo',
    walletId: PRACTICE_WALLET_ID,
    code: PRACTICE_CODE,
    balanceCents: wallet,
    hasPin: true,
    isHomeVenue: true,
    blocked: false,
    closeRequested: false,
    cashOutCents: 0,
    cashOutNote: null,
    fichaNumber: null,
  };
}

function cash(body: { amountCents?: number; wallet?: unknown }): Response {
  if (!isPracticeRef(body.wallet)) return notPractice();
  const amountCents = body.amountCents ?? 0;
  wallet += amountCents;
  const out: CashTopUpResult = {
    topUpId: newId('RECARGA'),
    walletId: PRACTICE_WALLET_ID,
    code: PRACTICE_CODE,
    amountCents,
    serviceFeeCents: 0,
    serviceFeeBps: null,
    chargedCents: amountCents,
    balanceCents: wallet,
    createdWallet: false,
    replayed: false,
  };
  return json(201, out);
}

function payWithPin(chargeId: string, body: { pin?: string }): Response {
  const charge = charges.get(chargeId);
  if (!charge) return problem(404, 'Cobro no encontrado.');
  if (!isPracticeRef(body)) return notPractice();
  if (body.pin !== PRACTICE_PIN) return problem(422, 'PIN incorrecto. En práctica vale 1234.', 'WRONG_PIN');
  if (wallet < charge.amountCents) return problem(409, 'Saldo insuficiente.', 'WALLET_INSUFFICIENT');
  const payment = charge.paymentId ? payments.get(charge.paymentId) : undefined;
  if (payment) payment.status = 'CANCELED';
  charge.status = 'ACCEPTED';
  charge.newBalanceCents = wallet - charge.amountCents;
  wallet = charge.newBalanceCents;
  emit('wallet-charge:update', { id: charge.id, status: charge.status });
  return json(200, saldoState(charge));
}

function readRoute(route: string, seg: string[]): Response | null {
  // Lo real que podría aparecer solo (cobros por confirmar, sin pagar, recargas): vacío en práctica.
  if (['/v1/payments/pending-pos', '/v1/payments/sin-pagar', '/v1/reception/topups/pending'].includes(route)) return json(200, []);
  if (seg[1] === 'payments' && seg[2] === 'public') {
    const p = [...payments.values()].find((x) => x.qrToken === seg[3]);
    if (!p) return problem(404, 'Cobro no encontrado.');
    const polled: PolledPayment = { status: p.status, ...(p.status === 'AUTHORIZED' ? { id: p.id, tipCents: 0, payMethod: 'card' as const } : {}) };
    return json(200, polled);
  }
  if (seg[1] === 'wallet-charges' && seg[2] === 'wallets') return seg[3] === PRACTICE_WALLET_ID ? json(200, lookup()) : notPractice();
  if (seg[1] === 'wallet-charges' && seg[2] === 'lookup') return isPracticeRef({ code: seg[3] ?? '' }) ? json(200, lookup()) : notPractice();
  if (seg[1] === 'wallet-charges' && seg.length === 3 && seg[2]!.startsWith(PRACTICE_ID_PREFIX)) {
    const c = charges.get(seg[2]!);
    return c ? json(200, saldoState(c)) : problem(404, 'Cobro no encontrado.');
  }
  if (seg[1] === 'payments' && seg[3] === 'bitcoin') return json(200, { invoice: null });
  // Cualquier otra lectura de algo de práctica: no existe (no se pide al API real).
  if (seg.some((s) => s.startsWith(PRACTICE_ID_PREFIX))) return problem(404, 'Esto es de práctica y no tiene más detalle.');
  return null;
}

function writeRoute(route: string, seg: string[], body: Record<string, unknown>): Response | null {
  switch (route) {
    case '/v1/payments':
      return createPayment(body);
    case '/v1/wallet-charges/qr':
      return createSaldo(body);
    case '/v1/reception/cash':
      return cash(body);
    case '/v1/reception/desk':
      return isPracticeRef(body) ? json(200, deskView()) : notPractice();
    case '/v1/wallet-charges/cards/lookup':
      return isPracticeRef(body) ? json(200, lookup()) : notPractice();
    default:
  }
  const id = seg[2] ?? '';
  if (!id.startsWith(PRACTICE_ID_PREFIX)) return null;
  if (seg[1] === 'payments' && seg[3] === 'cancel') {
    const p = payments.get(id);
    if (p) p.status = 'CANCELED';
    return json(200, { status: 'CANCELED' });
  }
  if (seg[1] !== 'wallet-charges') return null;
  if (seg[3] === 'cancel') {
    const c = charges.get(id);
    if (c) c.status = 'CANCELED';
    return json(200, null);
  }
  if (seg[3] === 'nfc') {
    // La ficha de práctica siempre pide su PIN (así se ensaya el teclado).
    return body.card === PRACTICE_CARD ? problem(409, 'Esta ficha necesita su PIN.', PIN_REQUIRED_CODE, 'night_cap') : notPractice();
  }
  if (seg[3] === 'pin') return payWithPin(id, body as { pin?: string });
  return null;
}

/**
 * Atiende una llamada del personal en práctica. null: no es de las que se
 * simulan; api.ts deja pasar las lecturas (GET) y corta todo lo demás.
 */
export function practiceRoute(path: string, init: RequestInit): Response | null {
  const method = (init.method ?? 'GET').toUpperCase();
  const route = path.split('?')[0]!;
  const seg = route.split('/').filter(Boolean).map(decodeURIComponent);
  if (method === 'GET') return readRoute(route, seg);
  if (method !== 'POST') return null;
  let body: Record<string, unknown> = {};
  try {
    if (typeof init.body === 'string') body = JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return writeRoute(route, seg, body);
}

/**
 * La puerta única de las llamadas al API (api.ts). Sin práctica, pasa tal cual.
 * En práctica: lo simulado lo contesta el simulador; las lecturas (GET) pasan
 * al API real (la carta, las opciones…); y todo lo demás (POST, PUT, PATCH,
 * DELETE) NUNCA llega a la red: sube un error claro.
 */
export function practiceFetch(
  on: boolean,
  path: string,
  init: RequestInit,
  real: (path: string, init: RequestInit) => Promise<Response>,
): Promise<Response> {
  if (!on) return real(path, init);
  const simulated = practiceRoute(path, init);
  if (simulated) return Promise.resolve(simulated);
  const method = (init.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return real(path, init);
  return Promise.reject(new PracticeBlockedError(`${method} ${path.split('?')[0]}`));
}

/** «Salir de práctica»: todo lo simulado se borra y la app arranca limpia (nada de práctica queda en pantalla). */
export function leavePractice(reload: () => void = () => window.location.reload()): void {
  setPractice(false);
  resetPracticeSim();
  reload();
}
