// Recepción: recargar el saldo del cliente (tarjeta o efectivo), darle una
// ficha y que elija su PIN; y «Preparar fichas» (grabar fichas en blanco para
// el stock). La misma pantalla en el datáfono (credencial del aparato) y en el
// móvil del personal (su sesión): cambia el «backend» de llamadas.
// Lógica pura probada en reception.test.ts.

import {
  serviceFeeOf,
  serviceFeeQuote,
  topUpChargeText,
  type CashTopUpDto,
  type CashTopUpResult,
  type ReceptionOptions,
  type StockOutcome,
  type TopUpWalletDto,
} from '@nightpay/contracts';
import { ApiError } from '@nightpay/api-client';
import { call } from './pax-api';
import {
  fetchReceptionOptions,
  fetchWalletById,
  linkWalletCard,
  receptionCashTopUp,
  receptionFichaStock,
  receptionFichaNumber,
  receptionFichaToken,
  receptionLookupCard,
  setWalletPin,
} from './api';
import { formatEur } from './money';

/** La ficha acercada para recargar: de qué saldo es, sin enseñarlo. */
export interface ReceptionCard {
  walletId: string;
  codeHint: string;
  hasPin: boolean;
  /** El saldo es de este local (con tarjeta solo se recarga aquí). */
  isHomeVenue: boolean;
}

/** El saldo recién recargado (el cliente está delante). */
export interface ReceptionWallet {
  walletId: string;
  code: string;
  balanceCents: number;
  hasPin: boolean;
  hasCard: boolean;
}

/**
 * Cómo quedó una recarga con tarjeta que cobró este datáfono
 * (GET /v1/pos-device/reception/topups/:paymentId, la última hora).
 */
export interface ReceptionTopUpView {
  paymentId: string;
  /** Sumada · cobrada y pendiente de Paytef · aún sin cobrar · no cobrada (caducada, cancelada). */
  status: 'CREDITED' | 'PENDING' | 'OPEN' | 'NOT_PAID';
  amountCents: number;
  walletId: string;
  codeHint: string;
  balanceCents: number | null;
  hasPin: boolean;
  hasCard: boolean;
}

/** Lo que enseña la recepción con esa respuesta. */
export type TopUpCheck =
  | { kind: 'done'; detail: string }
  | { kind: 'pending' }
  | { kind: 'notPaid' }
  /** Aún sin cobrar en el servidor: se vuelve a preguntar. */
  | { kind: 'wait' };

export function topUpCheck(view: ReceptionTopUpView): TopUpCheck {
  if (view.status === 'PENDING') return { kind: 'pending' };
  if (view.status === 'NOT_PAID') return { kind: 'notPaid' };
  if (view.status === 'OPEN') return { kind: 'wait' };
  const extras = [view.hasCard ? 'ficha' : null, view.hasPin ? 'PIN' : null].filter(Boolean).join(' y ');
  const balance = view.balanceCents === null ? '' : ` · tiene ${formatEur(view.balanceCents)}`;
  return { kind: 'done', detail: `Saldo ${view.codeHint}${balance}${extras ? ` · con ${extras}` : ''}` };
}

/** Venta con tarjeta en el lector del datáfono (recarga ya preparada en el servidor). */
export interface DeviceCardSale {
  paymentId: string;
  reference: string;
  /** Lo que pide el lector: la recarga + la comisión del servicio. */
  amountCents: number;
  walletId: string;
  /** El desglose (un API de antes no lo manda). */
  topUpCents?: number;
  serviceFeeCents?: number;
}

/**
 * Las llamadas de la recepción. El datáfono va con su credencial
 * (/v1/pos-device/reception/*); el móvil, con la sesión de la persona
 * (/v1/reception/* y la ficha y el PIN de siempre por /v1/wallet-charges).
 */
export interface ReceptionBackend {
  kind: 'device' | 'staff';
  options(): Promise<ReceptionOptions>;
  lookup(card: string, uid: string | null): Promise<ReceptionCard>;
  cash(body: CashTopUpDto): Promise<CashTopUpResult>;
  wallet(walletId: string): Promise<ReceptionWallet>;
  /** Da la ficha al saldo recién recargado (en el móvil va por su código). */
  link(wallet: ReceptionWallet, card: string, uid: string | null): Promise<ReceptionWallet>;
  setPin(wallet: ReceptionWallet, pin: string): Promise<ReceptionWallet>;
  /** Código nuevo para grabar en una ficha en blanco. */
  newToken(): Promise<string>;
  /** La ficha acercada en «Preparar fichas», al stock. */
  stock(card: string, uid: string | null): Promise<StockOutcome>;
  labelStock?(card: string, uid: string, printedNumber: string): Promise<{ printedNumber: string }>;
}

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
const cardBody = (card: string, uid: string | null) => (uid ? { card, uid } : { card });

/** El datáfono de recepción (Authorization: Device). */
export const deviceBackend: ReceptionBackend & {
  cardSale(body: { amountCents: number; idempotencyKey: string; wallet: { create: true } | { card: string; uid?: string } }): Promise<DeviceCardSale>;
  topUp(paymentId: string): Promise<ReceptionTopUpView>;
} = {
  kind: 'device',
  options: () => call('/v1/pos-device/reception/options'),
  lookup: (card, uid) => call('/v1/pos-device/reception/lookup', json(cardBody(card, uid))),
  cash: (body) => call('/v1/pos-device/reception/cash', json(body)),
  cardSale: (body) => call('/v1/pos-device/reception/card', json(body)),
  topUp: (paymentId) => call(`/v1/pos-device/reception/topups/${encodeURIComponent(paymentId)}`),
  wallet: (walletId) => call(`/v1/pos-device/reception/wallets/${encodeURIComponent(walletId)}`),
  link: (w, card, uid) => call(`/v1/pos-device/reception/wallets/${encodeURIComponent(w.walletId)}/card`, json(cardBody(card, uid))),
  setPin: (w, pin) => call(`/v1/pos-device/reception/wallets/${encodeURIComponent(w.walletId)}/pin`, json({ pin })),
  newToken: async () => (await call<{ card: string }>('/v1/pos-device/reception/fichas/token', json({}))).card,
  stock: (card, uid) => call('/v1/pos-device/reception/fichas/stock', json(cardBody(card, uid))),
  // «Preparar fichas» del datáfono: también su número impreso (con la ficha delante).
  labelStock: (card, uid, printedNumber) => call('/v1/pos-device/reception/fichas/number', json({ card, uid, printedNumber })),
};

/** El móvil del personal (su sesión). */
export const staffBackend: ReceptionBackend = {
  kind: 'staff',
  options: fetchReceptionOptions,
  lookup: receptionLookupCard,
  cash: receptionCashTopUp,
  wallet: async (walletId) => receptionWalletOf(await fetchWalletById(walletId)),
  link: async (w, card, uid) => receptionWalletOf(await linkWalletCard(w.code, card, uid)),
  setPin: async (w, pin) => receptionWalletOf(await setWalletPin(w.code, pin)),
  newToken: receptionFichaToken,
  stock: receptionFichaStock,
  labelStock: receptionFichaNumber,
};

function receptionWalletOf(w: { walletId: string; code: string; balanceCents: number; hasPin: boolean; hasCard: boolean }): ReceptionWallet {
  return { walletId: w.walletId, code: w.code, balanceCents: w.balanceCents, hasPin: w.hasPin, hasCard: w.hasCard };
}

// ─── «Comisión del servicio» de una recarga ──────────────────────────────

/** Lo que se cobra por una recarga: el saldo + la comisión del servicio del local (si la tiene). */
export interface TopUpCharge {
  feeCents: number;
  totalCents: number;
  /** «Cobra 56 € (50 € de saldo + 6 € de comisión del servicio)»; sin ella, «Cobra 50 €». */
  text: string;
  /**
   * Lo que va en la recarga en efectivo: la comisión que se enseñó (si el
   * local la tiene encendida, también a 0 %). Si cambió, el servidor no la
   * apunta (409) y se vuelve a cobrar con la nueva.
   */
  body: { serviceFeeCents?: number };
}

/** Con las opciones de la recepción (un API de antes no la manda: apagada). */
export function topUpCharge(options: Pick<ReceptionOptions, 'serviceFee'> | null | undefined, amountCents: number): TopUpCharge {
  const quote = serviceFeeQuote(serviceFeeOf(options?.serviceFee), 'topUp', amountCents);
  return {
    feeCents: quote.feeCents,
    totalCents: quote.totalCents,
    text: topUpChargeText(amountCents, quote.feeCents),
    body: quote.bps === null ? {} : { serviceFeeCents: quote.feeCents },
  };
}

/** Los 409 que dicen que la comisión del servicio que se enseñó ya no vale. */
const SERVICE_FEE_STALE = new Set(['SERVICE_FEE_CHANGED', 'SERVICE_FEE_APP_OUTDATED']);

/**
 * ¿El servidor no apuntó la recarga porque la comisión del servicio cambió
 * (o esta pantalla no la tenía)? Entonces hay que volver a pedir las opciones
 * y enseñar el total nuevo antes de cobrar (no reenviar la vieja).
 */
export function serviceFeeStale(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && SERVICE_FEE_STALE.has(code);
}

/**
 * Una recarga en efectivo que el servidor no apuntó porque la comisión del
 * servicio cambió: se vuelven a pedir las opciones (la pantalla enseña ya el
 * total nuevo) y sale un 409 con lo que hay que cobrar ahora. Al volver a
 * pulsar, va la comisión nueva (antes se reenviaba la vieja hasta recargar).
 */
export async function cashWithFreshFee<T>(
  send: () => Promise<T>,
  fee: { refresh: () => Promise<ReceptionOptions>; onOptions: (o: ReceptionOptions) => void; amountCents: number },
): Promise<T> {
  try {
    return await send();
  } catch (err) {
    if (!serviceFeeStale(err)) throw err;
    let fresh: ReceptionOptions;
    try {
      fresh = await fee.refresh();
    } catch {
      // El 409 dice que no se cargó nada: aunque no se pueda traer el importe
      // nuevo, nunca «no se sabe si se cargó».
      throw new ApiError(SERVICE_FEE_CHANGED_OFFLINE, 409, 'SERVICE_FEE_CHANGED');
    }
    fee.onOptions(fresh);
    throw new ApiError(serviceFeeChangedText(fresh, fee.amountCents), 409, 'SERVICE_FEE_CHANGED');
  }
}

/** La comisión cambió y no se pudo traer la nueva (sin red): no se ha cobrado nada. */
const SERVICE_FEE_CHANGED_OFFLINE =
  'La comisión del servicio ha cambiado y no se ha cobrado nada. Vuelve a abrir la recarga para ver el importe nuevo.';

/** «La comisión del servicio ha cambiado. Ahora: Cobra 57 € (…). Vuelve a cobrar.» */
export function serviceFeeChangedText(options: Pick<ReceptionOptions, 'serviceFee'> | null | undefined, amountCents: number): string {
  return `La comisión del servicio ha cambiado. Ahora: ${topUpCharge(options, amountCents).text}. Vuelve a cobrar.`;
}

// ─── Pasos de la recepción ───────────────────────────────────────────────

/** Cómo paga la recarga. */
export type PayMethod = 'card' | 'cash';

/**
 * A qué saldo: uno nuevo, el del NFC que acerca o el de su código (K7Q-4M2,
 * en «Recargar saldo» de Inicio).
 */
export type Target =
  | { kind: 'new' }
  | { kind: 'card'; card: string; uid: string | null; view: ReceptionCard }
  | { kind: 'code'; code: string; view: ReceptionCard };

/** El saldo de la recarga en el cuerpo de la petición. */
export function walletOfTarget(target: Target): TopUpWalletDto {
  if (target.kind === 'new') return { create: true };
  if (target.kind === 'code') return { code: target.code };
  return target.uid ? { card: target.card, uid: target.uid } : { card: target.card };
}

/**
 * El botón de la tarjeta: en el datáfono pasa por su lector; en el móvil del
 * personal, el cliente paga en su propio móvil con el QR (tarjeta, Apple Pay
 * o Google Pay).
 */
export function cardMethodLabel(on: 'device' | 'staff'): string {
  return on === 'device' ? 'Tarjeta (en este datáfono)' : 'Tarjeta / Apple Pay / Google Pay (en su móvil)';
}

/** Por qué esta forma de pago no vale para este saldo (null: vale). */
export function payProblem(method: PayMethod, target: Target, options: ReceptionOptions): string | null {
  if (method === 'cash' && !options.cash) return options.cashBlockedReason ?? 'Aquí no se cobran recargas en efectivo.';
  if (method === 'card' && !options.card) return 'Ahora no se pueden hacer recargas con tarjeta en este local.';
  if (method === 'card' && target.kind !== 'new' && !target.view.isHomeVenue) {
    return 'Este saldo es de otro local del grupo: aquí, recárgalo en efectivo.';
  }
  return null;
}

/** Después de cobrar: ficha (si no tiene y hay fichas), PIN (si no tiene) y el resultado. */
export type AfterPay = 'chip' | 'pin' | 'done';

export function nextAfterPay(w: Pick<ReceptionWallet, 'hasCard' | 'hasPin'>, opts: { nfc: boolean; skipChip?: boolean; skipPin?: boolean }): AfterPay {
  if (!w.hasCard && opts.nfc && !opts.skipChip) return 'chip';
  if (!w.hasPin && !opts.skipPin) return 'pin';
  return 'done';
}

/** Lo que dice el resultado: el saldo, lo que tiene y si tiene ficha y PIN. */
export function receptionDetail(w: ReceptionWallet): string {
  const extras = [w.hasCard ? 'ficha' : null, w.hasPin ? 'PIN' : null].filter(Boolean).join(' y ');
  return `Saldo ${w.code} · tiene ${formatEur(w.balanceCents)}${extras ? ` · con ${extras}` : ''}`;
}

/**
 * Recarga de un saldo que ya tenía (su ficha): el resultado sale de lo que
 * devolvió el cobro, sin pedir el saldo otra vez (el datáfono solo puede
 * pedir los saldos que creó él).
 */
export function walletAfterCash(out: Pick<CashTopUpResult, 'walletId' | 'code' | 'balanceCents'>, card: ReceptionCard): ReceptionWallet {
  return { walletId: out.walletId, code: out.code, balanceCents: out.balanceCents, hasPin: card.hasPin, hasCard: true };
}

/** El resultado de una recarga con tarjeta a la ficha que ya tenía (el saldo nuevo no se sabe aquí). */
export function existingTopUpDetail(card: ReceptionCard): string {
  return `Saldo ${card.codeHint} · con ficha${card.hasPin ? ' y PIN' : ''}`;
}

/** Una clave por intento de recarga: si se repite (corte, doble toque) no carga dos veces. */
export function newReceptionKey(): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return `rec-${rnd}`;
}

/** La clave de la recarga y lo que se recarga con ella. */
export interface ReceptionAttempt {
  readonly key: string;
  readonly what: string;
}

/** Lo que se recarga: importe, forma de pago y a qué saldo. */
export function receptionWhat(amountCents: number, method: PayMethod, target: Target): string {
  const to = target.kind === 'new' ? 'nuevo' : target.kind === 'code' ? `codigo:${target.code}` : `ficha:${target.card}`;
  return `${amountCents}|${method}|${to}`;
}

/**
 * La misma clave solo si se repite lo mismo (corte, doble toque). Con otro
 * importe, otra forma de pago u otro saldo, clave nueva: el servidor no
 * devuelve la recarga anterior como si fuera esta.
 */
export function receptionAttempt(previous: ReceptionAttempt | null, what: string): ReceptionAttempt {
  return previous?.what === what ? previous : { key: newReceptionKey(), what };
}

// ─── La recarga en efectivo en curso, guardada en la pestaña (S-4) ───────
// Si la pantalla falla a mitad («Esta pantalla ha fallado» → «Volver a
// cobrar» recarga la app), la clave se perdía con la memoria: al repetir la
// misma recarga, iba con clave nueva y el efectivo se cargaba dos veces. Ahora
// la de efectivo queda en sessionStorage (solo esta pestaña) un rato: repetir
// lo mismo (importe, efectivo, la misma ficha o código) va con la misma clave.

/** Donde se guarda (sessionStorage). */
export const CASH_ATTEMPT_STORAGE_KEY = 'np-recepcion-efectivo';

/** Pasado este tiempo sin tocarla, ya no es «la misma recarga a medias», sino otra. */
export const CASH_ATTEMPT_TTL_MS = 10 * 60_000;

/** Lo que se usa del almacenamiento (en las pruebas, uno de mentira). */
export interface AttemptStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** ¿Es una recarga en efectivo? (`what`: «importe|forma de pago|saldo»). */
export function isCashAttempt(attempt: ReceptionAttempt): boolean {
  return attempt.what.split('|')[1] === 'cash';
}

/** La recarga en efectivo a medias de esta pestaña, si la hay y es reciente. Si falla al leerla, ninguna. */
export function loadCashAttempt(storage: AttemptStorage | null, now: number): ReceptionAttempt | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(CASH_ATTEMPT_STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as { key?: unknown; what?: unknown; at?: unknown };
    if (typeof saved.key !== 'string' || typeof saved.what !== 'string' || typeof saved.at !== 'number') return null;
    if (now < saved.at || now - saved.at > CASH_ATTEMPT_TTL_MS) return null;
    const attempt = { key: saved.key, what: saved.what };
    return isCashAttempt(attempt) ? attempt : null;
  } catch {
    return null;
  }
}

/** La guarda (si es de efectivo) o la quita. Sin almacenamiento, como antes: la clave vive en la memoria. */
export function saveCashAttempt(storage: AttemptStorage | null, attempt: ReceptionAttempt | null, now: number): void {
  if (!storage) return;
  try {
    if (attempt && isCashAttempt(attempt)) storage.setItem(CASH_ATTEMPT_STORAGE_KEY, JSON.stringify({ key: attempt.key, what: attempt.what, at: now }));
    else storage.removeItem(CASH_ATTEMPT_STORAGE_KEY);
  } catch {
    // Lleno o bloqueado: la clave sigue en la memoria (lo de siempre).
  }
}

/**
 * Como el `useRef` de la recarga en curso, pero lo que se le asigna (y es de
 * efectivo) queda también en la pestaña; al crearse, empieza con lo guardado.
 */
export function cashAttemptRef(storage: AttemptStorage | null, now: () => number = Date.now): { current: ReceptionAttempt | null } {
  let value = loadCashAttempt(storage, now());
  return {
    get current() {
      return value;
    },
    set current(next: ReceptionAttempt | null) {
      value = next;
      saveCashAttempt(storage, next, now());
    },
  };
}

/** sessionStorage del navegador; null en el servidor o si el navegador no lo deja tocar. */
export function browserSessionStorage(): AttemptStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

// ─── «Preparar fichas» ────────────────────────────────────────────────────

/** Lo que pasó con la ficha acercada, para la lista de la pantalla. */
export interface PrepareLine {
  tone: 'ok' | 'info' | 'warn';
  text: string;
  /** Cuenta como preparada (grabada nueva o devuelta al stock). */
  counts: boolean;
}

export function stockOutcomeLine(o: StockOutcome): PrepareLine {
  switch (o.outcome) {
    case 'stocked':
      return { tone: 'ok', text: 'Grabada y en el stock', counts: true };
    case 'returned':
      return { tone: 'ok', text: `Era de ${o.codeHint} (ya sin saldo): vuelve al stock`, counts: true };
    case 'already':
      return { tone: 'info', text: 'Ya estaba en el stock', counts: false };
    case 'in-use':
      return { tone: 'warn', text: `Es de ${o.codeHint}, que aún tiene saldo: apártala`, counts: false };
    case 'lost':
      return { tone: 'warn', text: 'Estaba marcada como perdida: apártala (o recupérala en el panel)', counts: false };
    case 'blocked':
      return { tone: 'warn', text: 'Está bloqueada: apártala', counts: false };
    case 'foreign':
      return { tone: 'warn', text: 'No es una ficha de este local (o es una copia): apártala', counts: false };
  }
}

/** «12 fichas preparadas» / «1 ficha preparada». */
export function preparedText(n: number): string {
  return n === 1 ? '1 ficha preparada' : `${n} fichas preparadas`;
}
