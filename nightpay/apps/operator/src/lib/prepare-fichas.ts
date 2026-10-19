// «Preparar fichas»: reglas pequeñas de la pantalla (probadas en prepare-fichas.test.ts).

/**
 * Tras leer una ficha sigue apoyada unos segundos: el lector la vuelve a ver.
 * Si es la misma (mismo número de serie) dentro de este tiempo, no se cuenta.
 */
export const SAME_TAP_MS = 4000;

export function isSameTapAgain(last: { uid: string | null; at: number } | null, uid: string | null, now: number): boolean {
  if (!last || !uid || last.uid !== uid) return false;
  return now - last.at < SAME_TAP_MS;
}
