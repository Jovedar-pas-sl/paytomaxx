// Cifras que suben contando (Grafito 3): al cambiar un total de «Esta noche»,
// la cifra recorre el camino del valor anterior al nuevo en ~500 ms. Con
// «reducir movimiento», salta directa. La cuenta es pura (probada); el hook
// solo pone el reloj.

/** Duración de la subida. */
export const COUNT_UP_MS = 500;

/** Salida suave: arranca rápida y se asienta (1 − (1 − t)³). */
export function easeOutCubic(t: number): number {
  const k = Math.min(1, Math.max(0, t));
  return 1 - (1 - k) ** 3;
}

/** El valor mostrado a mitad de camino (t de 0 a 1), siempre entero. */
export function countUpValue(from: number, to: number, t: number): number {
  if (t >= 1) return to;
  return Math.round(from + (to - from) * easeOutCubic(t));
}
