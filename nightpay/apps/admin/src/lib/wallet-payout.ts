// «Devolver saldo»: lo que se dice al apuntarlo (lógica pura, probada en wallet-payout.test.ts).

import { formatEur } from './money';

export interface WalletPayoutResult {
  refundedCents: number;
  method: 'CASH' | 'CARD';
  /** Lo que sigue en el saldo: en efectivo solo sale lo que entró en efectivo (y sin llegar a 1.000 € en 24 h). */
  remainingCents?: number;
}

export function payoutDoneText(res: WalletPayoutResult): string {
  const remaining = res.remainingCents ?? 0;
  if (res.method === 'CASH' && remaining > 0) {
    return `Se devuelven ${formatEur(res.refundedCents)} en efectivo; quedan ${formatEur(remaining)} para devolver a la tarjeta.`;
  }
  return `Apuntado: ${formatEur(res.refundedCents)} devueltos ${res.method === 'CASH' ? 'en efectivo' : 'a la tarjeta'}. Saldo cerrado.`;
}
