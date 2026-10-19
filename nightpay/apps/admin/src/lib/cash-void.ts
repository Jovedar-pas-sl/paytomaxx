// Anular una recarga en efectivo reciente (lógica pura, probada en cash-void.test.ts).

import { formatEur } from './money';

/** Por qué aún no se puede mandar (null: vale). El API pide el motivo (3+ letras) y el 2FA siempre. */
export function cashVoidProblem(reason: string, totpCode: string): string | null {
  if (reason.trim().length < 3) return 'Explica por qué se anula (mínimo 3 letras).';
  if (!/^\d{6}$/.test(totpCode)) return 'Pon los 6 números de tu app de verificación.';
  return null;
}

export function cashVoidDoneText(res: { amountCents: number; balanceCents: number }): string {
  return `Anulada: ${formatEur(res.amountCents)} salen de la caja. Al saldo le quedan ${formatEur(res.balanceCents)}.`;
}
