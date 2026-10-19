// Cobrar del saldo en el datáfono (pantalla /pax, «Cobrar con saldo»): el
// camarero elige el cobro con QR que hizo una chica (o escanea su QR), lee de
// qué saldo es (ficha NFC, QR del cliente o su código) y el cliente teclea su
// PIN en el datáfono. Lógica pura (probada en pax-saldo.test.ts) y las
// llamadas al API con la credencial del datáfono.

import { normalizeWalletCardUid, walletCardTokenFromUrl } from '@nightpay/contracts';
import { call, PaxApiError } from './pax-api';
import { callReader, type BridgeResponse } from './pax-bridge';
import { readCard } from './nfc';

/** Cobro con QR sin pagar del local. */
export interface SaldoCharge {
  id: string;
  amountCents: number;
  serviceName: string | null;
  requestedByName: string;
  createdAt: string;
  expiresAt: string;
}

/** De qué saldo es: su ficha, el QR de su pase de Google Wallet o su código. */
export type SaldoRef = { card: string; uid: string | null } | { walletToken: string } | { code: string };

/** Antes del PIN: si le llega, sin decir cuánto tiene. */
export interface SaldoCheck {
  codeHint: string;
  hasPin: boolean;
  pinLocked: boolean;
  pinByStaff: boolean;
  enough: boolean;
}

export type SaldoChargeStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'CANCELED';

export interface SaldoChargeView {
  id: string;
  status: SaldoChargeStatus;
  amountCents: number;
  serviceName: string | null;
  expiresAt: string;
  newBalanceCents: number | null;
}

/** La app del datáfono se rinde antes que la web (pax-bridge, 130 s). */
export const SCAN_TIMEOUT_MS = 90_000;
export const NFC_TIMEOUT_MS = 60_000;

// ─── Lo que lee la cámara ────────────────────────────────────────────────

export type ScanTarget = { kind: 'charge'; payToken: string } | { kind: 'wallet'; ref: SaldoRef } | { kind: 'unknown' };

/** Los enlaces del cobro (/s/…), del pase (/w/…) y de la ficha. */
const LINK_TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
/** El código del cliente (K7Q-4M2): 6 letras o números. */
const WALLET_CODE = /^[A-Z0-9]{6}$/;

function walletCode(raw: string): string | null {
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return WALLET_CODE.test(code) ? code : null;
}

/**
 * ¿Qué QR ha leído el datáfono?
 *  - …/s/<payToken>: el cobro que enseña la chica en su móvil;
 *  - …/w/<token>: el pase de Google Wallet del cliente (el enlace de su saldo);
 *  - …/?saldo=K7Q4M2: el QR de la página del saldo del cliente (solo su código);
 *  - …/?ficha=<token>: el enlace de una ficha (si alguien lo pasó a QR);
 *  - K7Q-4M2 suelto: su código.
 * Solo se mira la ruta y el formato: el texto nunca se abre ni se navega.
 */
export function parseScan(raw: string): ScanTarget {
  const text = raw.trim();
  if (!text || text.length > 2048) return { kind: 'unknown' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    const code = walletCode(text);
    return code && text.length <= 8 ? { kind: 'wallet', ref: { code } } : { kind: 'unknown' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { kind: 'unknown' };
  const [, segment, token, ...rest] = url.pathname.replace(/\/+$/, '').split('/');
  if (rest.length === 0 && token && LINK_TOKEN.test(token)) {
    if (segment === 's') return { kind: 'charge', payToken: token };
    if (segment === 'w') return { kind: 'wallet', ref: { walletToken: token } };
  }
  const card = walletCardTokenFromUrl(text);
  if (card) return { kind: 'wallet', ref: { card, uid: null } };
  const code = walletCode(url.searchParams.get('saldo') ?? '');
  if (code) return { kind: 'wallet', ref: { code } };
  return { kind: 'unknown' };
}

// ─── Antes del PIN ───────────────────────────────────────────────────────

/** Por qué este saldo no puede pagar aquí con su PIN (null: que lo teclee). */
export function checkProblem(check: SaldoCheck): string | null {
  if (check.pinLocked) return 'Su PIN está bloqueado por fallos: avisa al encargado.';
  if (!check.hasPin) return 'Este cliente aún no tiene PIN: que pague con el QR desde su móvil, o que lo elija con el encargado.';
  if (check.pinByStaff) return 'Este PIN lo puso el encargado: este cobro se hace desde la app del personal.';
  if (!check.enough) return 'No le llega el saldo para este cobro.';
  return null;
}

/** Cómo se dice al cliente qué saldo se ha leído («Ficha · K7Q-•••»). */
export function refLabel(ref: SaldoRef, codeHint: string): string {
  if ('card' in ref) return `Ficha · ${codeHint}`;
  if ('walletToken' in ref) return `Pase · ${codeHint}`;
  return `Código · ${codeHint}`;
}

// ─── Tras teclear el PIN ─────────────────────────────────────────────────

/**
 * Qué hacer con un error al pagar con el PIN:
 *  - retry: PIN mal o demasiados intentos seguidos; se queda en el teclado.
 *  - uncertain: sin respuesta o error del servidor; puede que SÍ se cobrara:
 *    se pregunta por el cobro antes de decir nada (repetir no cobra dos veces).
 *  - stop: no se va a poder (bloqueado, cobro retirado, otro local…).
 */
export type PinErrorKind = 'retry' | 'uncertain' | 'stop';

export function classifyPinError(err: unknown): PinErrorKind {
  if (!(err instanceof PaxApiError)) return 'uncertain';
  if (err.status === 0 || err.status >= 500) return 'uncertain';
  if (err.status === 429) return 'retry';
  if (err.status === 422 && !/bloquead/i.test(err.message)) return 'retry';
  return 'stop';
}

export type OutcomeKind = 'paid' | 'failed' | 'expired';

/** El estado del cobro → la pantalla de resultado (null: sigue pendiente). */
export function outcomeOf(status: SaldoChargeStatus): OutcomeKind | null {
  if (status === 'PENDING') return null;
  if (status === 'ACCEPTED') return 'paid';
  return status === 'EXPIRED' ? 'expired' : 'failed';
}

export type PinResult =
  | { kind: 'retry'; message: string }
  | { kind: 'done'; outcome: OutcomeKind; newBalanceCents: number | null; message?: string };

const UNCERTAIN_TEXT =
  'Sin respuesta de OxioPay: vuelve a poner el PIN (si ya se cobró, saldrá Pagado; nunca se cobra dos veces).';

/**
 * El PIN tecleado → el cobro. retry: se queda en el teclado con su texto (PIN
 * mal, sin conexión…). done: la pantalla de resultado. Si no se sabe qué pasó
 * (corte, cobro que ya no está pendiente), manda el estado del cobro: un cobro
 * solo se ata a un saldo una vez, así que repetir nunca cobra dos veces.
 */
export async function submitPin(chargeId: string, ref: SaldoRef, pin: string): Promise<PinResult> {
  try {
    const result = await paySaldoWithPin(chargeId, ref, pin);
    const outcome = outcomeOf(result.status);
    if (!outcome) return { kind: 'retry', message: 'No se ha cobrado todavía: vuelve a poner el PIN.' };
    return { kind: 'done', outcome, newBalanceCents: result.newBalanceCents };
  } catch (err) {
    const kind = classifyPinError(err);
    const message = (err as Error).message;
    if (kind === 'retry') return { kind: 'retry', message };
    const fresh = await fetchSaldoCharge(chargeId).catch(() => null);
    const outcome = fresh ? outcomeOf(fresh.status) : null;
    if (outcome === 'paid') return { kind: 'done', outcome, newBalanceCents: null };
    if (kind === 'uncertain' && !outcome) {
      return { kind: 'retry', message: fresh ? 'No se ha cobrado: vuelve a poner el PIN.' : UNCERTAIN_TEXT };
    }
    return { kind: 'done', outcome: outcome ?? 'failed', newBalanceCents: null, message };
  }
}

// ─── Lectores (cámara y NFC) ─────────────────────────────────────────────

const READER_TEXT: Record<string, string> = {
  nfcUnavailable: 'Este datáfono no deja leer fichas desde la app: usa el QR del cliente o su código.',
  nfcDisabled: 'El NFC del datáfono está apagado: actívalo en sus ajustes o usa el código.',
  noCamera: 'No se puede usar la cámara del datáfono: usa la ficha o el código.',
  permissionDenied: 'La app no tiene permiso para la cámara: dalo en los ajustes del datáfono.',
  timeout: 'No se ha leído nada a tiempo: vuelve a intentarlo.',
  unreadable: 'No se ha podido leer: acércala otra vez y déjala quieta un segundo.',
  deviceIsBusy: 'El datáfono está con otra operación: espera a que termine.',
  notSupported: 'Esta versión de la app del datáfono no lo tiene: pide que la actualicen.',
  noReader: 'Esto solo funciona dentro de la app OxioPay del datáfono.',
};

export function readerErrorText(error: string, message?: string): string {
  return READER_TEXT[error] ?? message ?? 'Error del lector.';
}

export interface FichaRead {
  /** Lo grabado en la ficha (null: vacía o de otra cosa). */
  token: string | null;
  uid: string | null;
}

/** La respuesta de readNfc → la ficha. Cancelado → AbortError; otro fallo → Error con su texto. */
export function fichaFromBridge(r: BridgeResponse): FichaRead {
  if (!r.ok) {
    if (r.error === 'cancelled') throw new DOMException('Cancelado', 'AbortError');
    throw new Error(readerErrorText(r.error, r.message));
  }
  return {
    token: r.url ? walletCardTokenFromUrl(r.url) : null,
    uid: r.uid ? normalizeWalletCardUid(r.uid) : null,
  };
}

/** Espera la ficha: por el NFC de la app del datáfono o, en un móvil, con Web NFC. */
export async function readFicha(signal: AbortSignal, via: 'bridge' | 'web'): Promise<FichaRead> {
  if (via === 'web') {
    const read = await readCard(signal);
    return { token: read.token, uid: read.uid };
  }
  const onAbort = () => void callReader('cancelRead');
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return fichaFromBridge(await callReader('readNfc', { timeoutMs: NFC_TIMEOUT_MS }));
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Abre la cámara del datáfono. null: el camarero volvió sin leer nada. */
export async function scanWithCamera(): Promise<string | null> {
  const r = await callReader('scanQr', { timeoutMs: SCAN_TIMEOUT_MS });
  if (r.ok) return typeof r.text === 'string' && r.text ? r.text : null;
  if (r.error === 'cancelled') return null;
  throw new Error(readerErrorText(r.error, r.message));
}

// ─── API (Authorization: Device) ─────────────────────────────────────────

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export const fetchSaldoCharges = (signal?: AbortSignal): Promise<SaldoCharge[]> =>
  call('/v1/pos-device/saldo/charges', { signal });

export const scanSaldoCharge = (payToken: string): Promise<SaldoCharge> =>
  call('/v1/pos-device/saldo/charges/scan', json({ payToken }));

export const fetchSaldoCharge = (id: string): Promise<SaldoChargeView> =>
  call(`/v1/pos-device/saldo/charges/${encodeURIComponent(id)}`);

export const checkSaldoWallet = (id: string, ref: SaldoRef): Promise<SaldoCheck> =>
  call(`/v1/pos-device/saldo/charges/${encodeURIComponent(id)}/check`, json(refBody(ref)));

export const paySaldoWithPin = (id: string, ref: SaldoRef, pin: string): Promise<SaldoChargeView> =>
  call(`/v1/pos-device/saldo/charges/${encodeURIComponent(id)}/pin`, json({ ...refBody(ref), pin }));

/** Sin número de serie (ficha leída desde un QR), no se manda el campo. */
export function refBody(ref: SaldoRef): Record<string, string> {
  if ('card' in ref) return ref.uid ? { card: ref.card, uid: ref.uid } : { card: ref.card };
  if ('walletToken' in ref) return { walletToken: ref.walletToken };
  return { code: ref.code };
}
