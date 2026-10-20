// Recepción exprés en el móvil del personal (maquetas 4.1–4.7): Entrada
// (acercar el NFC, el importe y cómo paga: tres toques) y Salida (guardar el
// saldo para la próxima o devolverlo en efectivo); y «Recargar saldo» en
// Inicio. NFC = tarjeta, ficha o pulsera: se trata igual. Las llamadas y la
// lógica pura de cada paso (probada en reception-desk.test.ts).

import {
  fichaNumberText,
  MAX_CASH_TOP_UP_CENTS,
  type ReceptionDeskSaldo,
  type ReceptionDeskView,
  type ReceptionOptions,
  type SaldoRefDto,
} from '@nightpay/contracts';
import { parseProblemDetails } from '@nightpay/api-client';
import { authedFetch, operatorErrorMessage, parseOperatorApiError } from './api';
import { formatEur } from './money';
import { payProblem, type PayMethod, type Target } from './reception';
import type { StaffRole } from './roles';

export type { ReceptionDeskSaldo, ReceptionDeskView };

// ─── Llamadas ─────────────────────────────────────────────────────────────

/** El NFC acercado o el código tecleado → nuevo o su saldo (POST /v1/reception/desk). */
export async function fetchReceptionDesk(ref: SaldoRefDto): Promise<ReceptionDeskView> {
  const res = await authedFetch('/v1/reception/desk', { method: 'POST', body: JSON.stringify(ref) });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Saldo'));
  return res.json();
}

/** Lo que pasó al devolver en efectivo: hecho, o el encargado tiene que poner su código 2FA. */
export type CashPayoutResult = { kind: 'done'; refundedCents: number; remainingCents: number } | { kind: 'totp'; message: string };

/** La respuesta de «devolver en efectivo» → hecho, «tu código 2FA» o el error de siempre. */
export function cashPayoutResultOf(status: number, text: string): CashPayoutResult {
  if (status >= 200 && status < 300) {
    const body = JSON.parse(text) as { refundedCents: number; remainingCents?: number };
    return { kind: 'done', refundedCents: body.refundedCents, remainingCents: body.remainingCents ?? 0 };
  }
  const { message, code } = parseProblemDetails(text);
  if (status === 403 && code === 'TOTP_REQUIRED') return { kind: 'totp', message: message ?? 'Pon el código de tu app de verificación (2FA).' };
  throw new Error(operatorErrorMessage(status, message ?? undefined, 'Saldo', code));
}

/**
 * Devolver en efectivo (la devolución de siempre del encargado o el dueño,
 * POST /v1/wallet-charges/wallets/:id/payout): solo lo que entró en efectivo,
 * sin llegar a 1.000 € en 24 h; si se queda a 0, el NFC vuelve al stock.
 */
export async function payoutCash(walletId: string, totpCode?: string): Promise<CashPayoutResult> {
  const res = await authedFetch(`/v1/wallet-charges/wallets/${encodeURIComponent(walletId)}/payout`, {
    method: 'POST',
    body: JSON.stringify({ method: 'CASH', ...(totpCode ? { totpCode } : {}) }),
  });
  return cashPayoutResultOf(res.status, await res.text().catch(() => ''));
}

// ─── Lo que se enseña ─────────────────────────────────────────────────────

/** «ficha nº 0522» (en minúscula, para el medio de una frase). */
export function fichaText(n: number): string {
  return `ficha nº ${fichaNumberText(n)}`;
}

/** La fila del NFC leído (4.2 y 4.5): el título y la línea de debajo. */
export interface DeskRow {
  title: string;
  detail: string;
}

/**
 * 4.2: «NFC nuevo · Ficha nº 0522 · sin saldo», o el suyo con lo que le
 * queda. 4.5 (Salida): «Ficha nº 0388 · Saldo R3D-8LP · leída».
 */
export function deskRow(view: ReceptionDeskView, mode: 'entrada' | 'salida'): DeskRow {
  if (view.kind === 'new') return { title: 'NFC nuevo', detail: `Ficha nº ${fichaNumberText(view.fichaNumber)} · sin saldo` };
  const title = view.fichaNumber === null ? `Saldo ${view.code}` : `Ficha nº ${fichaNumberText(view.fichaNumber)}`;
  const saldo = view.fichaNumber === null ? null : view.code;
  if (mode === 'salida') return { title, detail: [saldo ? `Saldo ${saldo}` : null, 'leída'].filter(Boolean).join(' · ') };
  const left = view.balanceCents > 0 ? `Le quedan ${formatEur(view.balanceCents, { compact: true })}` : 'Sin saldo';
  return { title, detail: [left, saldo].filter(Boolean).join(' · ') };
}

/** El chip de 4.3: «Recarga · ficha nº 0522» (o «Recarga · K7Q-4M2» sin NFC, «Recarga · saldo nuevo»). */
export function rechargeChip(view: ReceptionDeskView | null): string {
  if (!view) return 'Recarga · saldo nuevo';
  if (view.fichaNumber !== null) return `Recarga · ${fichaText(view.fichaNumber)}`;
  return view.kind === 'saldo' ? `Recarga · ${view.code}` : 'Recarga · saldo nuevo';
}

/** Los importes rápidos del local (Ajustes → Noche), sin repetir y de menor a mayor. */
export function quickAmounts(cents: readonly number[]): number[] {
  return [...new Set(cents.filter((c) => Number.isInteger(c) && c > 0))].sort((a, b) => a - b);
}

/** Un botón de «¿Cómo paga?»: el de la forma por defecto del local, XL y primero. */
export interface MethodButton {
  method: PayMethod;
  primary: boolean;
  /** Por qué no se puede (null: se puede). */
  problem: string | null;
}

/**
 * 4.3: efectivo y tarjeta, la de por defecto (Ajustes → Noche) primero y en
 * grande. El efectivo solo sale si lo puede cobrar (solo recepción, el
 * encargado o el dueño: lo dice el servidor en ReceptionOptions).
 */
export function methodButtons(
  options: ReceptionOptions,
  target: Target,
  amountCents: number,
  preferred: PayMethod,
): MethodButton[] {
  const offered: PayMethod[] = [];
  if (options.cash) offered.push('cash');
  if (options.card) offered.push('card');
  offered.sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : 0));
  return offered.map((method, i) => {
    const tooBig = method === 'cash' && amountCents > MAX_CASH_TOP_UP_CENTS ? 'En efectivo, como mucho 999,99 € por recarga.' : null;
    return { method, primary: i === 0, problem: tooBig ?? payProblem(method, target, options) };
  });
}

/** La nota del PIN de 4.3: no frena la cola, se pone después. */
export function pinNote(noPinMaxCents: number): string {
  if (noPinMaxCents <= 0) return 'El PIN lo pone luego: hace falta para pagar con el NFC.';
  return `El PIN lo pone luego, solo hace falta para más de ${formatEur(noPinMaxCents, { compact: true })}.`;
}

/** El saldo de la recarga para la petición (y su clave): nuevo, el de su NFC o el de su código. */
export function deskTarget(view: ReceptionDeskView | null, nfc: { card: string; uid: string | null } | null): Target {
  if (!view || view.kind === 'new') return { kind: 'new' };
  const card = { walletId: view.walletId, codeHint: view.code, hasPin: view.hasPin, isHomeVenue: view.isHomeVenue };
  if (nfc) return { kind: 'card', card: nfc.card, uid: nfc.uid, view: card };
  return { kind: 'code', code: view.code, view: card };
}

/** Por qué este saldo no se recarga aquí (null: se puede). */
export function rechargeProblem(view: ReceptionDeskView | null): string | null {
  if (view?.kind === 'saldo' && view.blocked) return 'Este saldo está bloqueado: no se puede recargar. Avisa al encargado.';
  return null;
}

/** 4.4: lo que hace recepción con el dinero («Efectivo: 50 € a la caja»). */
export function loadedMoneyLine(method: PayMethod, amountCents: number): { label: string; amount: string; tail: string } {
  const amount = formatEur(amountCents, { compact: true });
  return method === 'cash'
    ? { label: 'Efectivo:', amount, tail: 'a la caja' }
    : { label: 'Tarjeta:', amount, tail: 'en su móvil' };
}

/** 4.4: qué hace con el NFC («Dale el NFC · ficha nº 0522»). */
export function handOverLine(view: ReceptionDeskView | null, linked: boolean): string {
  if (view?.kind === 'saldo') return view.fichaNumber === null ? `Saldo ${view.code}` : `Devuélvele su NFC · ${fichaText(view.fichaNumber)}`;
  if (view && linked) return `Dale el NFC · ${fichaText(view.fichaNumber)}`;
  return 'Sin NFC: que apunte su código';
}

// ─── Salida (4.5) ─────────────────────────────────────────────────────────

/** Los dos botones de la salida: guardar (de fábrica) o devolver en efectivo. */
export interface ExitPlan {
  /** Lo que le queda. */
  balanceCents: number;
  /** «Devolver 35 € en efectivo» (null: no le queda nada). */
  refundLabel: string | null;
  /** «Sacas 35 € de la caja · el NFC vuelve al stock». */
  refundDetail: string | null;
  /** Por qué no se puede devolver aquí (null: se puede). */
  refundBlocked: string | null;
  /** Lo que no sale en efectivo (lo entró con tarjeta…), dicho antes. */
  note: string | null;
}

/**
 * La salida: «Guardar para la próxima» siempre (el saldo no caduca y se lleva
 * su NFC); «Devolver X € en efectivo» con las reglas de la devolución de
 * siempre: solo lo que entró en efectivo (sin llegar a 1.000 € en 24 h), solo
 * el encargado (con el «Me voy» del cliente) o el dueño.
 */
export function exitPlan(view: ReceptionDeskSaldo, role: StaffRole): ExitPlan {
  const balance = view.balanceCents;
  if (balance <= 0) return { balanceCents: 0, refundLabel: null, refundDetail: null, refundBlocked: null, note: null };
  const cash = view.cashOutCents;
  const out = formatEur(cash, { compact: true });
  const all = cash >= balance;
  return {
    balanceCents: balance,
    refundLabel: cash > 0 ? `Devolver ${out} en efectivo` : 'Devolver en efectivo',
    refundDetail: cash > 0 ? `Sacas ${out} de la caja${all ? ' · el NFC vuelve al stock' : ''}` : null,
    refundBlocked: refundBlockedFor(view, role),
    note: view.cashOutNote,
  };
}

function refundBlockedFor(view: ReceptionDeskSaldo, role: StaffRole): string | null {
  if (role !== 'OWNER' && role !== 'MANAGER') return 'Devolver en efectivo lo hace el encargado o el dueño.';
  if (view.cashOutCents <= 0) return view.cashOutNote ?? 'Este saldo no se devuelve en efectivo.';
  if (role === 'MANAGER' && !view.closeRequested) return 'Antes, el cliente pulsa «Me voy» en su móvil (o lo devuelve el dueño).';
  return null;
}

/** Tras devolver: el NFC vuelve al stock, o lo que le queda (entró con tarjeta) y quién lo devuelve. */
export function refundDoneLine(remainingCents: number): string {
  if (remainingCents <= 0) return 'El NFC vuelve al stock: guárdalo.';
  return `Le quedan ${formatEur(remainingCents, { compact: true })} (con tarjeta): los devuelve el dueño «A la tarjeta». Se lleva su NFC.`;
}

// ─── El código tecleado ───────────────────────────────────────────────────

/** Lo tecleado → hasta 6 letras o cifras en mayúscula (sin el guion ni espacios). */
export function codeInput(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}

/** Las seis casillas del código (4.6): «K7Q4M» → K,7,Q,4,M,''. */
export function codeBoxes(code: string): string[] {
  const c = codeInput(code);
  return Array.from({ length: 6 }, (_, i) => c[i] ?? '');
}
