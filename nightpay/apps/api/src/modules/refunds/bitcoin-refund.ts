import { ConflictException } from '@nestjs/common';

/** Código del 409 de un cobro en bitcoin (las apps lo distinguen sin leer el texto). */
export const BITCOIN_REFUND_CODE = 'BITCOIN_REFUND_NOT_AVAILABLE';
/**
 * Regla del dueño: el bitcoin no se devuelve en bitcoin ni por la pasarela, solo
 * en euros. Un cobro: «Devolver en efectivo» (bitcoin-cash). Una carga de saldo o
 * un reservado: la app aún no lo apunta: que hable con el dueño.
 */
export const BITCOIN_REFUND_TEXT =
  'Se pagó con bitcoin: no se devuelve por el banco ni en bitcoin, solo en euros. Si es un cobro, con «Devolver en efectivo»; si es una carga de saldo o un reservado, habla con el dueño antes de dar el dinero.';

/** Un cobro en bitcoin no se devuelve por la pasarela ni como «Devolución BBVA» (el dinero no pasó por el banco). */
export function assertNotBitcoin(provider: string | null | undefined): void {
  if (provider === 'BTCPAY') throw new ConflictException({ code: BITCOIN_REFUND_CODE, message: BITCOIN_REFUND_TEXT });
}
