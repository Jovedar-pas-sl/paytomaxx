// Salida de recepción (maqueta 4.5): devolver el saldo en efectivo con el NFC
// del cliente y su PIN (o su Face ID en su móvil). NFC = tarjeta, ficha o
// pulsera. Las llamadas y lo que se enseña (probado en reception-cash-payout.test.ts).

import {
  PAYOUT_PASSKEY_REQUIRED_CODE,
  type ReceptionPayoutPasskeyRequest,
  type ReceptionPayoutPasskeyStatus,
  type ReceptionPayoutPlan,
} from '@nightpay/contracts';
import { parseProblemDetails } from '@nightpay/api-client';
import { authedFetch, operatorErrorMessage } from './api';
import { formatEur } from './money';
import type { ExitPlan, ReceptionDeskSaldo } from './reception-desk';
import type { StaffRole } from './roles';

export type { ReceptionPayoutPlan };

export type CashExitNfc = { card: string; uid: string | null } | null;
export type CashExitResult =
  | { kind: 'done'; refundedCents: number; remainingCents: number }
  | { kind: 'manager'; amountCents: number; message: string }
  | { kind: 'totp'; message: string }
  /** Su saldo tiene Face ID: que lo confirme en su móvil (el QR). */
  | { kind: 'passkey'; message: string };

/** Un saldo solo con su código (sin NFC): la salida la hace el panel. */
export const NO_NFC_EXIT_TEXT = 'Este saldo no tiene ficha: lo devuelve el encargado en el panel (Clientes → Saldos).';

const eur = (cents: number) => formatEur(cents, { compact: true });

/**
 * 4.5: «Guardar para la próxima» (de fábrica) y «Devolver X € en efectivo ·
 * Sacas X € de la caja · el NFC vuelve al stock». Sin efectivo que devolver,
 * no sale «Devolver 0 €». Para devolver hace falta el NFC original con su
 * número de serie y que el cliente lo confirme (su PIN o su Face ID).
 */
export function cashExitPlan(view: ReceptionDeskSaldo, nfc: CashExitNfc): ExitPlan {
  const keepDetail = view.fichaNumber === null ? 'Para otra noche · que guarde su código' : 'Para otra noche · se lleva su ficha';
  const plan = { balanceCents: view.balanceCents, keepDetail, refundLabel: null, refundDetail: null, refundBlocked: null };
  // Solo su código, sin NFC: aquí no se devuelve (lo hace el panel).
  if (view.fichaNumber === null && !nfc) return { ...plan, note: view.balanceCents > 0 ? NO_NFC_EXIT_TEXT : null };
  const cash = view.cashOutCents;
  if (cash <= 0) return { ...plan, note: view.cashOutNote };
  const rest = view.balanceCents - cash;
  return {
    ...plan,
    refundLabel: `Devolver ${eur(cash)} en efectivo`,
    refundDetail: rest > 0
      ? `Sacas ${eur(cash)} de la caja · los otros ${eur(rest)} vuelven a su tarjeta`
      : `Sacas ${eur(cash)} de la caja · la ficha vuelve al stock`,
    refundBlocked: refundBlocked(view, nfc),
    // «Los otros 15 € entraron con tarjeta…» ya lo dice la línea del botón.
    note: rest > 0 && view.cashOutNote?.startsWith('Los otros') ? null : view.cashOutNote,
  };
}

function refundBlocked(view: ReceptionDeskSaldo, nfc: CashExitNfc): string | null {
  if (!nfc) return 'Acerca la ficha original del cliente para devolver efectivo.';
  if (!nfc.uid) return 'Este lector no ha leído su número de serie (UID): acerca la ficha original con un Android.';
  if (view.blocked) return 'Saldo bloqueado: la salida la revisa el encargado.';
  if (!view.hasPin && !view.hasPasskey) return 'El cliente aún no tiene PIN: que lo devuelva el encargado.';
  return null;
}

/** El paso siguiente a «Devolver»: su Face ID (QR), la 2FA del encargado, dejarlo al encargado o el PIN. */
export type ExitNext = 'passkey' | 'totp' | 'manager' | 'pin';

export function exitNext(plan: Pick<ReceptionPayoutPlan, 'needs' | 'passkey'>): ExitNext {
  if (plan.passkey) return 'passkey';
  if (plan.needs === 'manager_2fa') return 'totp';
  if (plan.needs === 'manager_pending') return 'manager';
  return 'pin';
}

/** «Más de 100 €», «Pasas tu tope de la noche (300 €)»: por qué hace falta el encargado. */
export function exitReasonText(plan: Pick<ReceptionPayoutPlan, 'reasons' | 'nightCapCents'>): string {
  const parts: string[] = [];
  if (plan.reasons.includes('over_limit')) parts.push('Más de 100 €');
  if (plan.reasons.includes('night_cap')) parts.push(`Pasas tu tope de la noche (${eur(plan.nightCapCents)})`);
  if (plan.reasons.includes('no_passkey')) parts.push('Sin su Face ID');
  return parts.join(' · ');
}

/** El encargado (o el dueño) confirman la salida de un saldo con Face ID sin su móvil. */
export function canSkipPasskey(role: StaffRole): boolean {
  return role === 'MANAGER' || role === 'OWNER';
}

export function cashExitResult(status: number, text: string): CashExitResult {
  const { message, code } = parseProblemDetails(text);
  if (status === 403 && code === 'TOTP_REQUIRED') return { kind: 'totp', message: message ?? 'Pon el código de tu app de verificación (2FA).' };
  if (status === 409 && code === PAYOUT_PASSKEY_REQUIRED_CODE) return { kind: 'passkey', message: message ?? 'Que lo confirme en su móvil.' };
  if (status >= 200 && status < 300) {
    const body = safeJson(text);
    if (body.kind === 'manager' && Number.isInteger(body.amountCents)) {
      return { kind: 'manager', amountCents: body.amountCents as number, message: typeof body.message === 'string' ? body.message : '' };
    }
    if (body.kind === 'done' && Number.isInteger(body.refundedCents) && Number.isInteger(body.remainingCents)) {
      return { kind: 'done', refundedCents: body.refundedCents as number, remainingCents: body.remainingCents as number };
    }
  }
  throw new Error(operatorErrorMessage(status, message ?? undefined, 'Saldo', code));
}

function safeJson(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface CashExitInput {
  card: string;
  uid: string;
  /** Sin Face ID confirmado, el PIN del cliente. */
  pin?: string;
  expectedAmountCents: number;
  requestKey: string;
  totpCode?: string;
}

const base = (walletId: string) => `/v1/reception/wallets/${encodeURIComponent(walletId)}/payout`;

export async function receptionCashPayout(walletId: string, input: CashExitInput): Promise<CashExitResult> {
  const res = await authedFetch(base(walletId), { method: 'POST', body: JSON.stringify(input) });
  return cashExitResult(res.status, await res.text());
}

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    const { message, code } = parseProblemDetails(text);
    throw new Error(operatorErrorMessage(res.status, message ?? undefined, 'Saldo', code));
  }
  return JSON.parse(text) as T;
}

/** Antes del PIN: qué hace falta (el encargado, su Face ID…). */
export async function fetchPayoutPlan(walletId: string): Promise<ReceptionPayoutPlan> {
  return json(await authedFetch(`${base(walletId)}/plan`, { method: 'POST', body: '{}' }));
}

/** El QR para que confirme la salida con su Face ID en su móvil. */
export async function requestPayoutPasskey(
  walletId: string,
  input: Pick<CashExitInput, 'card' | 'uid' | 'expectedAmountCents' | 'requestKey'>,
): Promise<ReceptionPayoutPasskeyRequest> {
  return json(await authedFetch(`${base(walletId)}/passkey`, { method: 'POST', body: JSON.stringify(input) }));
}

export async function payoutPasskeyStatus(walletId: string, requestKey: string): Promise<ReceptionPayoutPasskeyStatus> {
  return json(await authedFetch(`${base(walletId)}/passkey/${encodeURIComponent(requestKey)}`));
}
