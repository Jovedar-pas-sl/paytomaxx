import type { ReservationPayKind } from '@nightpay/contracts';

/**
 * La Idempotency-Key de los pagos con tarjeta de una reserva:
 * `resv:<id de la reserva>:<DEPOSIT|REST|FULL>:<intento>`. Con ella la página
 * de pago (/pay) sabe que es de un reservado: no enseña el saldo del grupo a
 * quien paga (la señal es saldo solo al llegar) y no ofrece bitcoin.
 */
export const RESERVATION_KEY_PREFIX = 'resv:';

export function reservationPaymentKey(reservationId: string, kind: ReservationPayKind, attempt: number): string {
  return `${RESERVATION_KEY_PREFIX}${reservationId}:${kind}:${attempt}`;
}

export function isReservationPaymentKey(key: string | null | undefined): boolean {
  return typeof key === 'string' && key.startsWith(RESERVATION_KEY_PREFIX);
}
