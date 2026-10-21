import { authedFetch } from './api';
import { formatEur } from './money';
import type { ExitPlan, ReceptionDeskSaldo } from './reception-desk';

export type CashExitNfc = { card: string; uid: string | null } | null;
export type CashExitResult =
  | { kind: 'done'; refundedCents: number; remainingCents: number }
  | { kind: 'manager'; amountCents: number; message: string }
  | { kind: 'totp'; message: string };

/** Reception authorization is customer NFC + PIN; legacy admin payout rules stay separate. */
export function cashExitPlan(view: ReceptionDeskSaldo, nfc: CashExitNfc): ExitPlan {
  const amount = formatEur(view.cashOutCents, { compact: true });
  return {
    balanceCents: view.balanceCents,
    refundLabel: view.balanceCents > 0 ? `Devolver ${amount} en efectivo` : null,
    refundDetail: 'El cliente confirma con su PIN. Más de 100 €: confirma el encargado con su 2FA.',
    refundBlocked: !nfc ? 'Acerca el NFC original del cliente para devolver efectivo.'
      : !nfc.uid ? 'Este lector no ha leído el UID: usa el NFC original con un lector compatible.'
      : !view.hasPin ? 'El cliente necesita tener PIN; consulta al encargado.'
      : view.cashOutCents <= 0 ? (view.cashOutNote ?? 'Este saldo no se devuelve en efectivo.') : null,
    note: view.cashOutNote,
  };
}

export function cashExitResult(status: number, text: string): CashExitResult {
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text); } catch { /* Report a safe fallback below. */ }
  const message = typeof body.message === 'string' ? body.message : 'No se ha podido devolver el efectivo.';
  if (status === 403 && body.code === 'TOTP_REQUIRED') return { kind: 'totp', message };
  if (status >= 200 && status < 300) {
    if (body.kind === 'manager' && Number.isInteger(body.amountCents)) {
      return { kind: 'manager', amountCents: body.amountCents as number, message };
    }
    if (body.kind === 'done' && Number.isInteger(body.refundedCents) && Number.isInteger(body.remainingCents)) {
      return { kind: 'done', refundedCents: body.refundedCents as number, remainingCents: body.remainingCents as number };
    }
  }
  throw new Error(message);
}

export async function receptionCashPayout(walletId: string, input: {
  card: string; uid: string; pin: string; expectedAmountCents: number; requestKey: string; totpCode?: string;
}): Promise<CashExitResult> {
  const res = await authedFetch(`/v1/reception/wallets/${encodeURIComponent(walletId)}/payout`, {
    method: 'POST', body: JSON.stringify(input),
  });
  return cashExitResult(res.status, await res.text());
}
