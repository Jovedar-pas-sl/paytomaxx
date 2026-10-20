// Recepción: recargar el saldo del cliente (tarjeta o efectivo), darle una
// ficha y que elija su PIN; y «Preparar fichas» (grabar fichas en blanco para
// el stock). La misma pantalla en el datáfono (credencial del aparato) y en el
// móvil del personal (su sesión): cambia el «backend» de llamadas.
// Lógica pura probada en reception.test.ts.

import type {
  CashTopUpDto,
  CashTopUpResult,
  ReceptionOptions,
  StockOutcome,
  TopUpWalletDto,
} from '@nightpay/contracts';
import { call } from './pax-api';
import {
  fetchReceptionOptions,
  fetchWalletById,
  linkWalletCard,
  receptionCashTopUp,
  receptionFichaStock,
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
  amountCents: number;
  walletId: string;
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
};

function receptionWalletOf(w: { walletId: string; code: string; balanceCents: number; hasPin: boolean; hasCard: boolean }): ReceptionWallet {
  return { walletId: w.walletId, code: w.code, balanceCents: w.balanceCents, hasPin: w.hasPin, hasCard: w.hasCard };
}

// ─── Pasos de la recepción ───────────────────────────────────────────────

/** Cómo paga la recarga. */
export type PayMethod = 'card' | 'cash';

/** A qué saldo: uno nuevo o el de la ficha que acerca. */
export type Target = { kind: 'new' } | { kind: 'card'; card: string; uid: string | null; view: ReceptionCard };

/** El saldo de la recarga en el cuerpo de la petición. */
export function walletOfTarget(target: Target): TopUpWalletDto {
  if (target.kind === 'new') return { create: true };
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
  if (method === 'card' && target.kind === 'card' && !target.view.isHomeVenue) {
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
  return `${amountCents}|${method}|${target.kind === 'new' ? 'nuevo' : `ficha:${target.card}`}`;
}

/**
 * La misma clave solo si se repite lo mismo (corte, doble toque). Con otro
 * importe, otra forma de pago u otro saldo, clave nueva: el servidor no
 * devuelve la recarga anterior como si fuera esta.
 */
export function receptionAttempt(previous: ReceptionAttempt | null, what: string): ReceptionAttempt {
  return previous?.what === what ? previous : { key: newReceptionKey(), what };
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
