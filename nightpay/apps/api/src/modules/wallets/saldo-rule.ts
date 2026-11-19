import { ConflictException } from '@nestjs/common';
import { SALDO_NO_SE_DEVUELVE_CODE, SALDO_NO_SE_DEVUELVE_MESSAGE } from '@nightpay/contracts';

/**
 * El saldo no se devuelve (decisión del dueño, 17-nov-2026): ni «Me voy», ni
 * la salida de recepción, ni «Devolver saldo» del panel empiezan una
 * devolución nueva, entrara el saldo como entrara (también el de un
 * reservado). Se queda para la próxima visita.
 *
 * Lo pedido antes y aún pendiente se termina como siempre: el cliente pulsó
 * «Me voy» o recepción lo dejó para el encargado o «A la tarjeta»
 * (closeRequestedAt), o una devolución a la tarjeta quedó a medias (PENDING).
 * Desde este cambio nada pone closeRequestedAt.
 *
 * Las devoluciones que corrigen un error en un cobro no pasan por aquí.
 */
export function saldoNoSeDevuelve(): ConflictException {
  return new ConflictException({ message: SALDO_NO_SE_DEVUELVE_MESSAGE, code: SALDO_NO_SE_DEVUELVE_CODE });
}

/** ¿Hay una devolución del saldo pedida antes de este cambio y sin terminar? */
export function refundPendingFromBefore(wallet: { closeRequestedAt: Date | null }, halfDoneCardPayout: boolean): boolean {
  return wallet.closeRequestedAt !== null || halfDoneCardPayout;
}
