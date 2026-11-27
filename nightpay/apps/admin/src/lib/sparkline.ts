// El minigráfico de «Pagado esta noche» (idea 9 B), en cuentas puras: una
// línea por horas dentro de una caja de SPARK_WIDTH × `height`. La escala va
// del menor al mayor contando siempre el 0: todo a cero es una línea plana
// abajo y lo negativo (una recarga anulada) baja del 0. Arriba y abajo queda
// margen para el punto de la última hora.

export const SPARK_WIDTH = 100;
/** Margen arriba y abajo (en la caja): el punto de la última hora cabe entero. */
const PAD = 3;

export interface SparkGeometry {
  /** «x,y x,y …» para el `points` de la polyline. */
  points: string;
  /** La última hora (donde va el punto). */
  last: { x: number; y: number };
  /** Dónde cae el 0. */
  zeroY: number;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Con menos de dos horas no hay línea que pintar: null. */
export function sparkGeometry(values: readonly number[], height: number): SparkGeometry | null {
  if (values.length < 2) return null;
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min;
  const inner = height - 2 * PAD;
  const yOf = (v: number) => round(span === 0 ? height - PAD : PAD + ((max - v) / span) * inner);
  const step = SPARK_WIDTH / (values.length - 1);
  const pts = values.map((v, i) => ({ x: round(i * step), y: yOf(v) }));
  return { points: pts.map((p) => `${p.x},${p.y}`).join(' '), last: pts[pts.length - 1]!, zeroY: yOf(0) };
}

/** La hora con más pagado (la primera si empatan); null si ninguna pasa de 0. */
export function peakIndex(values: readonly number[]): number | null {
  let best: number | null = null;
  values.forEach((v, i) => {
    if (v > 0 && (best === null || v > values[best]!)) best = i;
  });
  return best;
}
