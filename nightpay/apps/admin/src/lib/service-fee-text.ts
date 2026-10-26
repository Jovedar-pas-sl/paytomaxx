// «Comisión del servicio» (la paga el cliente encima del precio y es de
// OxioPay) en las pantallas del panel que no son de un informe. Lógica pura.

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
