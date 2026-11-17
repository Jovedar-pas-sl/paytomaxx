/**
 * La espera del banco, con los mismos tiempos para el cliente («Comprobando el
 * pago», en el API) y para el personal (Esperando, TPV): los dos ven lo mismo
 * a la vez. Cuentan desde que el intento salió hacia el banco (AUTHORIZING,
 * el `createdAt` del intento en payment_attempts).
 */

/**
 * Lo que se espera al aviso del banco antes de dejar al cliente intentarlo otra
 * vez (2 min 30 s): tiene que cubrir a un cliente que sigue en el 3D Secure de
 * su banco para no abrir un segundo pedido que también pudiera pagarse. Lo usa
 * decideRedsysRetry (API) y el «El cliente puede volver a intentarlo» del personal.
 */
export const RETRY_WAIT_MS = 150_000;

/** Desde aquí, el banco «está tardando» (franja ámbar del personal; texto del cliente). */
export const BANK_SLOW_AFTER_MS = 20_000;

/** Desde aquí, «Sigue esperando al banco» (personal) / «Seguimos esperando a tu banco» (cliente). */
export const BANK_STILL_WAITING_AFTER_MS = 60_000;

/** El cliente: desde aquí, «Suele tardar unos segundos. No cierres esta página.». */
export const BANK_CONFIRMING_HINT_AFTER_MS = 8_000;

/**
 * «Cancelar cobro» con el cliente en la página de su banco (AUTHORIZING con
 * tarjeta, Redsys u otra pasarela; con bitcoin no hay banco): no se puede
 * durante los primeros 2 minutos desde que salió al banco (decisión del dueño).
 * Pasados sin respuesta del banco, sí. El API lo hace cumplir (409 con
 * CANCEL_AT_BANK_TOO_SOON_CODE) y la app del personal cuenta con el mismo reloj.
 */
export const CANCEL_AT_BANK_AFTER_MS = 120_000;

/** El código del 409 al cancelar antes de esos 2 minutos. */
export const CANCEL_AT_BANK_TOO_SOON_CODE = 'CANCEL_AT_BANK_TOO_SOON';

/** Lo que falta (ms) para poder cancelar desde que salió al banco; 0 = ya se puede (sin saber desde cuándo, también). */
export function cancelAtBankWaitMs(sinceMs: number | null, nowMs: number): number {
  if (sinceMs === null || !Number.isFinite(sinceMs)) return 0;
  return Math.max(0, sinceMs + CANCEL_AT_BANK_AFTER_MS - nowMs);
}

/** Fases de la espera del banco (las mismas para el cliente y para el personal). */
export type BankWaitPhase = 'confirming' | 'slow' | 'still' | 'retry';

/**
 * En qué fase está la espera: hasta 20 s confirmando, hasta 60 s tardando,
 * hasta 2:30 esperando y, pasado ese plazo, se puede volver a intentar (si el
 * cobro aún se puede pagar; si no, sigue esperando la respuesta del banco).
 */
export function bankWaitPhase(elapsedMs: number, canRetry = true): BankWaitPhase {
  const ms = Math.max(0, elapsedMs);
  if (ms < BANK_SLOW_AFTER_MS) return 'confirming';
  if (ms < BANK_STILL_WAITING_AFTER_MS) return 'slow';
  if (ms < RETRY_WAIT_MS || !canRetry) return 'still';
  return 'retry';
}
