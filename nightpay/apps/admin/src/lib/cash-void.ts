// Anular una recarga en efectivo reciente (lógica pura, probada en cash-void.test.ts).

import { formatEur } from './money';

/** Por qué aún no se puede mandar (null: vale). El API pide el motivo (3+ letras) y el 2FA siempre. */
export function cashVoidProblem(reason: string, totpCode: string): string | null {
  if (reason.trim().length < 3) return 'Explica por qué se anula (mínimo 3 letras).';
  if (!/^\d{6}$/.test(totpCode)) return 'Pon los 6 números de tu app de verificación.';
  return null;
}

/**
 * Lo que sale de la caja al anularla: el saldo y, si la llevó, su «Comisión
 * del servicio» («112,00 € (100,00 € de saldo + 12,00 € de comisión del servicio)»).
 */
export function cashVoidOutText(t: { amountCents: number; serviceFeeCents?: number }): string {
  const fee = t.serviceFeeCents ?? 0;
  if (fee <= 0) return formatEur(t.amountCents);
  return `${formatEur(t.amountCents + fee)} (${formatEur(t.amountCents)} de saldo + ${formatEur(fee)} de comisión del servicio)`;
}

/** A ciegas (la encargada con la noche abierta), la lista no lleva importes: lo que sale se sabe al anular. */
export const CASH_VOID_BLIND_TEXT = 'Importe oculto con la noche abierta';

/** Lo que sale de la caja de una recarga de la lista; a ciegas, sin cifras. */
export function cashVoidRowText(t: { amountCents: number | null; serviceFeeCents?: number }): string {
  return t.amountCents === null ? CASH_VOID_BLIND_TEXT : cashVoidOutText({ amountCents: t.amountCents, serviceFeeCents: t.serviceFeeCents });
}

export function cashVoidDoneText(res: { amountCents: number; balanceCents: number; serviceFeeCents?: number }): string {
  return `Anulada: ${cashVoidOutText(res)} salen de la caja. Al saldo le quedan ${formatEur(res.balanceCents)}.`;
}

/**
 * Lo que se manda al anularla: con la comisión que se enseñó (sin ella, el API
 * no anula una recarga que la lleva). Un API de antes no la da: no se manda.
 */
export function cashVoidBody(
  t: { amountCents: number | null; serviceFeeCents?: number },
  reason: string,
  totpCode: string,
): { reason: string; totpCode: string; serviceFeeCents?: number } {
  return { reason: reason.trim(), totpCode, ...(t.serviceFeeCents === undefined ? {} : { serviceFeeCents: t.serviceFeeCents }) };
}
