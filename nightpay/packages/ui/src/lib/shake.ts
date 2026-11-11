// PIN mal: los puntos tiemblan y el móvil vibra [30, 60, 30]. El temblor se
// repite aunque falle dos veces seguidas porque se alternan dos clases.

import { haptic, HAPTIC_BAD } from './haptic';

/** Falló el PIN: vibra [30, 60, 30]. (El contador sube aparte, con setState: nada de efectos en el actualizador.) */
export function pinFailed(): void {
  haptic(HAPTIC_BAD);
}

/** La clase del temblor para el intento n (0: ninguno aún). */
export function shakeClass(count: number): string {
  if (count <= 0) return '';
  return count % 2 === 1 ? 'np-shake-a' : 'np-shake-b';
}
