// Vibración corta (Android): un toque que se nota sin molestar. En iOS y en
// ordenadores `navigator.vibrate` no existe: no hace nada (nunca falla). Si la
// persona apagó «Vibrar al tocar» (Mi perfil, Este móvil), tampoco vibra.

import { hapticEnabled } from './device-settings';

/** Añadir a la cuenta, cobrar y confirmar: 10-15 ms. */
export const HAPTIC_TAP_MS = 12;
/** PIN mal: dos golpes. */
export const HAPTIC_BAD: readonly number[] = [30, 60, 30];

/** Vibra si el navegador puede; devuelve si lo intentó (para las pruebas). */
export function haptic(pattern: number | readonly number[] = HAPTIC_TAP_MS, nav?: Pick<Navigator, 'vibrate'> | undefined): boolean {
  const n = nav ?? (typeof navigator !== 'undefined' ? navigator : undefined);
  if (!n || typeof n.vibrate !== 'function') return false;
  if (!hapticEnabled()) return false;
  try {
    return n.vibrate(typeof pattern === 'number' ? pattern : [...pattern]);
  } catch {
    return false;
  }
}
