// El pago a medias de un reservado (con tarjeta o con bitcoin) cuando se anula
// la reserva (el local o el cliente) o se cobra el resto en efectivo: lo que se
// dice si no se puede cancelar todavía (el bitcoin ya en la red, el cliente en
// su banco). Cancelar lo hace PaymentsService, con las reglas de «Cancelar cobro».

import { ConflictException } from '@nestjs/common';
import { CANCEL_AT_BANK_AFTER_MS, CANCEL_AT_BANK_TOO_SOON_CODE } from '@nightpay/contracts';
import { BITCOIN_CONFIRMING_CODE } from '../payments/payments.service';

/** El `code` de un 409 de negocio ({ code, message }), o null. */
export function conflictCode(err: unknown): string | null {
  if (!(err instanceof ConflictException)) return null;
  const body = err.getResponse();
  const code = typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : null;
}

// Los textos, cortos (menos de 120 letras): la app del personal no enseña un 409 más largo.

/** El cliente anula su reserva con su pago con bitcoin ya en la red: llegaría igual. */
export const CLIENT_BITCOIN_CONFIRMING =
  'Tu pago con bitcoin ya está en la red y falta su confirmación: aún no se puede cancelar. Espera unos minutos.';

/** El local anula con el pago con bitcoin del cliente ya en la red: llegaría igual. */
export const VENUE_BITCOIN_CONFIRMING =
  'El cliente ya pagó con bitcoin y falta que la red lo confirme: aún no se puede anular la reserva. Espera unos minutos.';

/** Ese 409 del bitcoin en la red, con el texto de quien anula (mismo código). */
export function bitcoinConfirming(message: string): ConflictException {
  return new ConflictException({ code: BITCOIN_CONFIRMING_CODE, message });
}

/**
 * El resto en efectivo en la puerta con el pago del resto aún en marcha (lo que
 * dijo «Cancelar cobro» de ese pago): por qué no se cobra en efectivo, para el
 * personal. null si es otro error.
 */
export function restPayingText(err: unknown): string | null {
  const code = conflictCode(err);
  if (code === BITCOIN_CONFIRMING_CODE) {
    return 'El cliente ya pagó el resto con bitcoin y falta que la red lo confirme: no cobres en efectivo. Espera unos minutos.';
  }
  if (code === CANCEL_AT_BANK_TOO_SOON_CODE) {
    return `El cliente está pagando el resto en su banco: no cobres en efectivo. Si en ${CANCEL_AT_BANK_AFTER_MS / 60_000} minutos no responde, ya podrás.`;
  }
  return null;
}

/** Con el pago del resto en marcha por otra causa. */
export const REST_PAYING_TEXT = 'El cliente está pagando el resto: no cobres en efectivo hasta que termine.';

/** El 409 del resto en efectivo con el pago del resto en marcha. */
export const RESERVATION_PAY_OPEN_CODE = 'RESERVATION_PAY_OPEN';
