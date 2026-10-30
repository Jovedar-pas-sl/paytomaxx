// «Cobrar» y el cobro único en la app del personal: un cobro que se paga con
// la tarjeta (el QR) o con el saldo (el NFC en este móvil, su PIN o su Face
// ID desde la página de pago). Los errores llevan su `code` del API: la
// pantalla de NO PAGADO dice la razón en una frase («Saldo insuficiente»).

import {
  ALREADY_PAID_CODE,
  PIN_REQUIRED_CODE,
  type ChargeAuthMethod,
  type ChargeLineInput,
  type InvitableStaff,
  type InvitationRules,
} from '@nightpay/contracts';
import { SessionExpiredError, parseProblemDetails } from '@nightpay/api-client';
import {
  authedFetch,
  newIdempotencyKey,
  operatorErrorMessage,
  type CreatedPayment,
  type WalletChargeStatus,
  type WalletLookup,
} from './api';

/** Error del API con su código (WALLET_INSUFFICIENT, ALREADY_PAID…) y la frase para la pantalla. */
export class CobroApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  /** PIN_REQUIRED: por qué (over_max, night_cap…). */
  readonly reason: string | null;

  constructor(status: number, message: string, code: string | null, reason: string | null = null) {
    super(message);
    this.name = 'CobroApiError';
    this.status = status;
    this.code = code;
    this.reason = reason;
  }
}

/** La respuesta de error → CobroApiError con la frase de siempre y su código. */
export function cobroErrorOf(status: number, text: string, context: string): CobroApiError {
  const { message, code } = parseProblemDetails(text);
  let reason: string | null = null;
  try {
    const body = JSON.parse(text) as { reason?: unknown };
    reason = typeof body.reason === 'string' ? body.reason : null;
  } catch {
    reason = null;
  }
  return new CobroApiError(status, operatorErrorMessage(status, message ?? undefined, context, code), code, reason);
}

async function call<T>(path: string, init: RequestInit, context: string): Promise<T> {
  const res = await authedFetch(path, init);
  const text = await res.text().catch(() => '');
  if (!res.ok) throw cobroErrorOf(res.status, text, context);
  return (text ? JSON.parse(text) : null) as T;
}

/** El cobro único creado: el QR de la tarjeta y, si el local cobra con saldo, el cobro del saldo enlazado. */
export interface CobroCreado extends CreatedPayment {
  saldo?: { chargeId: string; expiresAt: string } | null;
}

export interface CobroInput {
  lines: ChargeLineInput[];
  tipCents?: number;
  /** «Copa con invitación»: el QR de la chica o la elegida de la lista. */
  invitedStaffToken?: string;
  invitedOperatorId?: string;
  terminalExternalId?: string;
  zone?: string;
  /** Con datáfono (si el local lo tiene): el camarero lo cobra en el aparato. */
  pos?: boolean;
  /** Una por intento: un doble toque no crea dos cobros. */
  idempotencyKey?: string;
}

/** POST /v1/payments: el cobro con tarjeta y, enlazado, el del saldo (withSaldo). */
export function createCobro(input: CobroInput): Promise<CobroCreado> {
  const body: Record<string, unknown> = { currency: 'EUR', lines: input.lines };
  if (input.terminalExternalId) body.terminalExternalId = input.terminalExternalId;
  if (input.zone) body.zone = input.zone;
  if (input.pos) body.captureMethod = 'POS_EXTERNAL';
  else body.withSaldo = true;
  if (input.tipCents && input.tipCents > 0) body.tipCents = input.tipCents;
  if (input.invitedStaffToken) body.invitedStaffToken = input.invitedStaffToken;
  if (input.invitedOperatorId) body.invitedOperatorId = input.invitedOperatorId;
  return call<CobroCreado>(
    '/v1/payments',
    { method: 'POST', headers: { 'Idempotency-Key': input.idempotencyKey ?? newIdempotencyKey() }, body: JSON.stringify(body) },
    'Cobro',
  );
}

/** Cobro del saldo (con su QR /s): el local sin tarjeta, solo con saldo. */
export interface SaldoCobro {
  id: string;
  ref: string | null;
  status: WalletChargeStatus;
  amountCents: number;
  tipCents?: number;
  expiresAt: string;
  payUrl: string;
  qrPngDataUrl: string;
}

export function createSaldoCobro(input: Omit<CobroInput, 'terminalExternalId' | 'zone' | 'pos' | 'idempotencyKey'>): Promise<SaldoCobro> {
  const body: Record<string, unknown> = { lines: input.lines };
  if (input.tipCents && input.tipCents > 0) body.tipCents = input.tipCents;
  if (input.invitedStaffToken) body.invitedStaffToken = input.invitedStaffToken;
  if (input.invitedOperatorId) body.invitedOperatorId = input.invitedOperatorId;
  return call<SaldoCobro>('/v1/wallet-charges/qr', { method: 'POST', body: JSON.stringify(body) }, 'Cobro del saldo');
}

/** El cobro del saldo: ¿ya lo pagó?, cómo y lo que le queda. */
export interface SaldoState {
  id: string;
  ref: string | null;
  status: WalletChargeStatus;
  amountCents: number;
  tipCents?: number;
  newBalanceCents: number | null;
  paidWith?: ChargeAuthMethod | null;
  /** Cobro único: lo pagó la tarjeta. */
  paidElsewhere?: boolean;
}

export function fetchSaldoState(id: string, signal?: AbortSignal): Promise<SaldoState> {
  return call<SaldoState>(`/v1/wallet-charges/${encodeURIComponent(id)}`, { signal }, 'Cobro del saldo');
}

export function cancelSaldo(id: string): Promise<void> {
  return call<void>(`/v1/wallet-charges/${encodeURIComponent(id)}/cancel`, { method: 'POST' }, 'Cancelar cobro');
}

export function cancelCard(paymentId: string): Promise<void> {
  return call<void>(`/v1/payments/${encodeURIComponent(paymentId)}/cancel`, { method: 'POST' }, 'Cancelación');
}

/** El NFC acercado al móvil: pagado (hasta el tope sin PIN) o hace falta su PIN. */
export type NfcOutcome = { kind: 'paid'; state: SaldoState } | { kind: 'pin'; reason: string | null; message: string };

export async function payByNfc(id: string, card: string, uid: string | null): Promise<NfcOutcome> {
  try {
    const state = await call<SaldoState>(
      `/v1/wallet-charges/${encodeURIComponent(id)}/nfc`,
      { method: 'POST', body: JSON.stringify({ card, ...(uid ? { uid } : {}) }) },
      'Cobro',
    );
    return { kind: 'paid', state };
  } catch (err) {
    if (err instanceof CobroApiError && err.status === 409 && err.code === PIN_REQUIRED_CODE) {
      return { kind: 'pin', reason: err.reason, message: err.message };
    }
    throw err;
  }
}

/**
 * De qué saldo es, sin su móvil: la ficha NFC que acercó, el código que dice
 * (K7Q-4M2) o el QR de su pase de Google Wallet (solo el de cobrar, /c/<token>).
 */
export type SaldoRef = { card: string; uid: string | null } | { code: string } | { walletToken: string };

/** El cuerpo de POST /v1/wallet-charges/:id/pin: el saldo (uno solo) y su PIN. */
export function pinBody(ref: SaldoRef, pin: string): Record<string, string> {
  if ('card' in ref) return { card: ref.card, ...(ref.uid ? { uid: ref.uid } : {}), pin };
  if ('code' in ref) return { code: ref.code, pin };
  return { walletToken: ref.walletToken, pin };
}

/** Su PIN, tecleado en este móvil, con su ficha, su código o su pase. */
export function payByPin(id: string, ref: SaldoRef, pin: string): Promise<SaldoState> {
  return call<SaldoState>(
    `/v1/wallet-charges/${encodeURIComponent(id)}/pin`,
    { method: 'POST', body: JSON.stringify(pinBody(ref, pin)) },
    'PIN del saldo',
  );
}

/** Su código (K7Q-4M2): de quién es, si tiene PIN y lo que tiene (para el «No le llega»). */
export function lookupCode(code: string): Promise<WalletLookup> {
  return call<WalletLookup>(`/v1/wallet-charges/lookup/${encodeURIComponent(code)}`, {}, 'Código de saldo');
}

/** El pase de Google Wallet escaneado para este cobro: si tiene PIN y si le llega, sin enseñar su saldo. */
export interface PassCheck {
  /** «K7Q-•••». */
  codeHint: string;
  hasPin: boolean;
  pinLocked: boolean;
  /** El PIN lo puso quien cobra o quien hizo el cobro: lo tiene que cobrar otra persona. */
  ownPin: boolean;
  /** Le llega para este cobro. */
  enough: boolean;
}

export function checkPass(chargeId: string, walletToken: string): Promise<PassCheck> {
  return call<PassCheck>(
    `/v1/wallet-charges/${encodeURIComponent(chargeId)}/pass`,
    { method: 'POST', body: JSON.stringify({ walletToken }) },
    'Pase del saldo',
  );
}

/** De quién es el NFC (su código y lo que tiene): para el PIN y el «Tiene 30 €». */
export function lookupNfc(card: string, uid: string | null): Promise<WalletLookup> {
  return call<WalletLookup>(
    '/v1/wallet-charges/cards/lookup',
    { method: 'POST', body: JSON.stringify({ card, ...(uid ? { uid } : {}) }) },
    'NFC',
  );
}

/** «Nerea reconocida»: de quién es el QR que acaba de leer el camarero. */
export function resolveStaffQr(token: string): Promise<InvitableStaff> {
  return call<InvitableStaff>('/v1/operators/staff-qr/resolve', { method: 'POST', body: JSON.stringify({ token }) }, 'QR de la chica');
}

/** Las chicas del local (si el local deja elegirla de la lista). */
export function fetchInvitables(): Promise<InvitableStaff[]> {
  return call<InvitableStaff[]>('/v1/operators/invitables', {}, 'Chicas');
}

/** Cómo se reparte una invitación (Ajustes → Invitaciones). */
export function fetchInvitationRules(): Promise<InvitationRules> {
  return call<InvitationRules>('/v1/admin/venue/invitation-rules', {}, 'Invitaciones');
}

/** ¿La tarjeta ya lo pagó? (el NFC llegó tarde: «Ya está pagado»). */
export function isAlreadyPaid(err: unknown): boolean {
  return err instanceof CobroApiError && err.code === ALREADY_PAID_CODE;
}

/**
 * Un pago con el NFC o con el PIN que no devolvió el pagado: ¿se sabe que no
 * se cobró? Solo si el API lo rechazó (4xx con su razón, o la sesión ya no
 * vale). Sin respuesta (red, plazo agotado), con el servidor caído (5xx, 408)
 * o con una respuesta ilegible, el servidor pudo cobrarlo: se comprueba el
 * estado del cobro antes de decir nada (APP-02).
 */
export type PayFailure = 'already_paid' | 'ambiguous' | 'definitive';

export function payFailureKind(err: unknown): PayFailure {
  if (isAlreadyPaid(err)) return 'already_paid';
  if (err instanceof SessionExpiredError) return 'definitive';
  if (err instanceof CobroApiError) return err.status >= 500 || err.status === 408 ? 'ambiguous' : 'definitive';
  return 'ambiguous';
}
