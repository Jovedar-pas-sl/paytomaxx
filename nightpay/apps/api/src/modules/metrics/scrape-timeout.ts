/** Lo que espera un scrape a Redis o a la base antes de dar la medida por no disponible. */
export const SCRAPE_TIMEOUT_MS = 2000;

/** `work`, o un error si tarda más de `ms` (el temporizador no se queda colgado). */
export function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
