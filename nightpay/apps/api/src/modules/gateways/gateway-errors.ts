/**
 * Errores de la pasarela al ABRIR el pago (authorize).
 *
 * authorize() nunca cobra: prepara la página del banco (Redsys y Cecabank
 * firman un formulario sin red; Peanpe arma una URL; Paytef crea un enlace de
 * pago) y el cliente la recibe solo si authorize() sale bien. Si falla, nada
 * ha llegado al banco que se pueda cobrar, y la única pregunta es si repetir
 * puede salir bien (pasajero) o daría lo mismo (definitivo):
 *  - pasajero: la pasarela no respondió, respondió 5xx / 429 / 408, o el
 *    circuit breaker no dejó llamar. El cobro se deja como estaba y el
 *    cliente puede volver a intentarlo.
 *  - definitivo: todo lo demás (configuración, datos rechazados, respuesta
 *    rara). Ante la duda, definitivo: no se ofrece repetir.
 */
export class GatewayTransientError extends Error {
  override readonly name = 'GatewayTransientError';
}

/**
 * Códigos de opossum (circuit-breaker.ts): abierto (no se llamó a la
 * pasarela), tiempo agotado y demasiadas llamadas a la vez.
 */
const BREAKER_TRANSIENT_CODES: ReadonlySet<string> = new Set(['EOPENBREAKER', 'ETIMEDOUT', 'ESEMLOCKED']);

/** HTTP de la pasarela que se arregla esperando: 5xx, 429 (demasiadas) y 408 (tardó). */
function transientStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

export function isTransientGatewayError(err: unknown): boolean {
  if (err instanceof GatewayTransientError) return true;
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && BREAKER_TRANSIENT_CODES.has(code);
}

/** La respuesta HTTP de la pasarela que no fue bien, con su mensaje para el log. */
export function gatewayHttpError(status: number, message: string): Error {
  return transientStatus(status) ? new GatewayTransientError(message) : new Error(message);
}

/** Una llamada a la pasarela sin respuesta (red caída, DNS, tiempo agotado): pasajero. */
export async function gatewayFetch(call: () => Promise<Response>, label: string): Promise<Response> {
  try {
    return await call();
  } catch (err) {
    throw new GatewayTransientError(`${label} sin respuesta: ${(err as Error)?.message ?? String(err)}`);
  }
}
