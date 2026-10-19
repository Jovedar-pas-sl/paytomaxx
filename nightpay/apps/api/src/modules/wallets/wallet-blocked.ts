import { ConflictException } from '@nestjs/common';

/**
 * Saldo bloqueado por el super-admin (blockedAt): no se recarga (ni con
 * tarjeta, ni en efectivo, ni desde /w) ni se paga con él. 409 con un `code`
 * estable para que las páginas y las apps lo distingan.
 */
export const WALLET_BLOCKED_CODE = 'WALLET_BLOCKED';
export const WALLET_BLOCKED_MESSAGE = 'Este saldo está bloqueado: no se puede recargar ni pagar con él. Avisa al encargado.';

export class WalletBlockedException extends ConflictException {
  constructor() {
    super({ message: WALLET_BLOCKED_MESSAGE, code: WALLET_BLOCKED_CODE });
  }
}
