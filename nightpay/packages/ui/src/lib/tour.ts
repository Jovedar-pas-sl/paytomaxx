// El tutorial de cada pantalla (Tour): lo puro. Los pasos, cuáles se enseñan,
// cómo se avanza y qué se guarda en este móvil u ordenador (una clave por
// pantalla y versión). Sin pantalla: se prueba sin navegador.

/** Un paso: el elemento (su `data-tour`), un título corto y 1-2 frases. */
export interface TourStep {
  target: string;
  title: string;
  text: string;
}

/** Sube si cambian los pasos de una pantalla y conviene volver a enseñarlos a todos. */
export const TOUR_VERSION = 'v1';

/** «np-tour-cobrar-v1». */
export function tourKey(screen: string): string {
  return `np-tour-${screen}-${TOUR_VERSION}`;
}

/** Lo que se usa de localStorage (en las pruebas, uno de mentira). */
export interface TourStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** localStorage del navegador; null en el servidor o si el navegador no deja tocarlo. */
export function browserTourStorage(): TourStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Lo visto en esta sesión: si el almacenamiento falla, el tutorial no sale de nuevo solo (el «?» sí). */
const seenThisSession = new Set<string>();

/** ¿Ya lo vio? Si no se puede leer, se da por visto: nunca se insiste. */
export function hasSeenTour(screen: string, storage: TourStorage | null = browserTourStorage()): boolean {
  if (seenThisSession.has(screen)) return true;
  if (!storage) return true;
  try {
    return storage.getItem(tourKey(screen)) === '1';
  } catch {
    return true;
  }
}

/** Queda visto (al terminarlo o al saltarlo). */
export function markTourSeen(screen: string, storage: TourStorage | null = browserTourStorage()): void {
  seenThisSession.add(screen);
  if (!storage) return;
  try {
    storage.setItem(tourKey(screen), '1');
  } catch {
    // Sin almacenamiento: queda visto solo en esta sesión.
  }
}

/** Para las pruebas: olvida lo visto en la sesión. */
export function resetTourSession(): void {
  seenThisSession.clear();
}

export type TourCloseReason = 'done' | 'skip' | 'escape' | 'empty';

/** Los pasos cuyo elemento está en pantalla ahora; el resto se salta. */
export function presentSteps<E>(steps: readonly TourStep[], find: (target: string) => E | null): Array<{ step: TourStep; element: E }> {
  const out: Array<{ step: TourStep; element: E }> = [];
  for (const step of steps) {
    const element = find(step.target);
    if (element) out.push({ step, element });
  }
  return out;
}

/** Adelante o atrás; al pasar del último, termina. Nunca sale del rango. */
export function tourMove(index: number, count: number, dir: 'next' | 'prev'): { index: number } | 'done' {
  if (dir === 'prev') return { index: Math.max(0, index - 1) };
  return index + 1 >= count ? 'done' : { index: index + 1 };
}

/** Sale solo cuando la pantalla está libre y es la primera vez. */
export function shouldAutoStart(o: { seen: boolean; ready: boolean; modalOpen: boolean; tourOpen: boolean }): boolean {
  return !o.seen && o.ready && !o.modalOpen && !o.tourOpen;
}

/** Si se cierra por «Saltar», Escape o al terminar queda visto; si no había nada que enseñar, no. */
export function closeMarksSeen(reason: TourCloseReason): boolean {
  return reason !== 'empty';
}

/** El texto de «1 de 4». */
export function stepCounter(index: number, count: number): string {
  return `${index + 1} de ${count}`;
}

/** Dónde va la burbuja respecto al elemento: debajo, encima o, si no cabe, sobre la mitad con más sitio. */
export function bubblePlacement(o: { targetTop: number; targetBottom: number; viewportHeight: number; bubbleHeight: number; gap: number }): 'below' | 'above' | 'bottom' | 'top' {
  const roomBelow = o.viewportHeight - o.targetBottom;
  const roomAbove = o.targetTop;
  const need = o.bubbleHeight + o.gap;
  if (roomBelow >= need) return 'below';
  if (roomAbove >= need) return 'above';
  return roomBelow >= roomAbove ? 'bottom' : 'top';
}
