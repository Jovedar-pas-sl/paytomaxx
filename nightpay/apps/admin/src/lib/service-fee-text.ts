// «Comisión del servicio» (la paga el cliente encima del precio y es de
// OxioPay) en las pantallas del panel que no son de un informe. Lógica pura.

import { refundServiceFeePart } from '@nightpay/contracts';
import { formatEur } from './money';

/**
 * Lo que se dice al devolver un cobro que la lleva: en un pago directo vuelve
 * también su parte (en proporción); en una recarga, no (solo el saldo). Sin
 * ella, o con un API de antes que no la manda, null.
 */
export function refundServiceFeeHint(p: { serviceFeeCents?: number; walletId?: string | null }): string | null {
  const fee = p.serviceFeeCents ?? 0;
  if (fee <= 0) return null;
  if (p.walletId) return `La comisión del servicio de esta recarga (${formatEur(fee)}) no se devuelve: solo el saldo.`;
  return `Lleva ${formatEur(fee)} de comisión del servicio: al devolver, vuelve también su parte (en proporción a lo devuelto).`;
}

/**
 * La parte de una devolución que es comisión del servicio (lo mismo que
 * apunta el API: en proporción a lo cobrado, por lo acumulado): «De estos
 * 11,00 €, 0,95 € son comisión del servicio (…)». Una recarga, sin comisión
 * o con un importe que no vale: null.
 */
export function refundFeePartText(
  p: { amountCents: number; serviceFeeCents?: number; tipCents?: number; availableAmountCents: number; walletId?: string | null },
  refundCents: number | null,
): string | null {
  const fee = p.walletId ? 0 : (p.serviceFeeCents ?? 0);
  if (fee <= 0 || refundCents === null || refundCents <= 0 || refundCents > p.availableAmountCents) return null;
  const charged = p.amountCents + fee + (p.tipCents ?? 0);
  const before = Math.max(0, charged - p.availableAmountCents);
  const part = refundServiceFeePart({
    feeCents: fee,
    chargedCents: charged,
    refundedAfterCents: before + refundCents,
    feeRefundedBeforeCents: Math.round((fee * before) / charged),
  });
  if (part <= 0) return null;
  return `De estos ${formatEur(refundCents)}, ${formatEur(part)} son comisión del servicio (vuelven al cliente y dejan de ser de OxioPay).`;
}
