/**
 * Claves de Redis de la verificación del momento (step-up.service.ts). Aparte
 * para que el cierre de sesión (refresh-token.service.ts) la borre sin
 * depender del servicio.
 */

/** La verificación para ver lo delicado de esta sesión (5 minutos). */
export function stepUpKey(sessionId: string): string {
  return `np:stepup:${sessionId}`;
}
