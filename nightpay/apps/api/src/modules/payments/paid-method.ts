import type { PublicPaymentView } from '@nightpay/contracts';

/** Cómo pagó un cobro ya pagado, para el PAGADO del personal (PublicPaymentView.payMethod). */
export type PaidMethod = NonNullable<PublicPaymentView['payMethod']>;

/**
 * Del proveedor del cobro y del intento que cobró: con BTCPay, bitcoin (el
 * dinero está en la cartera del local, no en el banco), aunque el intento no lo
 * diga; si no, lo que dio el banco (tarjeta, o Apple Pay / Google Pay). Lo
 * demás (un datáfono, un cobro de antes sin intentos) no se dice: null.
 */
export function paidMethodOf(provider: string | null, approvedPayMethod: string | null): PaidMethod | null {
  if (provider === 'BTCPAY' || approvedPayMethod === 'bitcoin') return 'bitcoin';
  if (approvedPayMethod === 'card' || approvedPayMethod === 'wallet') return approvedPayMethod;
  return null;
}
