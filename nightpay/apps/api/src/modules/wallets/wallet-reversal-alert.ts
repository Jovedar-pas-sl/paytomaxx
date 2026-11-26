import { eurPlain } from '../../common/money/eur';

/** El aviso de Telegram al anular un cobro con saldo: cuánto vuelve, por qué y quién. Sin el código del saldo. */
export function reversalAlertText(o: { venueName: string; refundedCents: number; reason: string; actor: string }): string {
  return `${o.venueName}: cobro con saldo anulado. Vuelven ${eurPlain(o.refundedCents)} al saldo del cliente.\nMotivo: ${o.reason}\nLo anuló: ${o.actor}`;
}
