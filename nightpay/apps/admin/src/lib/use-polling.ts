'use client';

import { useCallback, useEffect, useRef, type DependencyList } from 'react';

/** Tras un fallo se espera el doble (hasta `maxMs`); tras un acierto, lo normal. */
export function nextPollDelay(previousMs: number, succeeded: boolean, baseMs: number, maxMs: number): number {
  if (succeeded) return baseMs;
  return Math.min(maxMs, Math.max(baseMs, previousMs) * 2);
}

interface PollingOptions {
  intervalMs: number;
  /** Espera máxima entre intentos cuando el API falla. Por defecto, 8 veces el intervalo. */
  maxIntervalMs?: number;
  /** false = no se pide nada (p. ej. otra pestaña del panel). */
  enabled?: boolean;
}

/**
 * Pide datos cada `intervalMs` mientras la pestaña del navegador se ve:
 *  - con la pestaña oculta no pide nada; al volver, refresca al momento;
 *  - si falla, espera cada vez más (no machaca un API caído);
 *  - nunca hay dos peticiones a la vez;
 *  - `task` recibe una señal que se aborta al cambiar `deps` o desmontar: una
 *    respuesta vieja que llega tarde no pisa la nueva (comprobar `signal.aborted`).
 * `task` devuelve true si fue bien. Devuelve una función para refrescar ya.
 */
export function usePolling(
  task: (signal: AbortSignal) => Promise<boolean>,
  { intervalMs, maxIntervalMs = intervalMs * 8, enabled = true }: PollingOptions,
  deps: DependencyList,
): () => void {
  const taskRef = useRef(task);
  taskRef.current = task;
  const refreshRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = intervalMs;
    let running = false;
    let rerun = false;

    async function run(): Promise<void> {
      if (controller.signal.aborted) return;
      if (running) {
        rerun = true;
        return;
      }
      clearTimeout(timer);
      if (document.visibilityState === 'hidden') return; // vuelve con visibilitychange
      running = true;
      let ok = false;
      try {
        ok = await taskRef.current(controller.signal);
      } catch {
        ok = false;
      }
      running = false;
      if (controller.signal.aborted) return;
      delay = nextPollDelay(delay, ok, intervalMs, maxIntervalMs);
      if (rerun) {
        rerun = false;
        void run();
        return;
      }
      timer = setTimeout(() => void run(), delay);
    }

    function onVisibility(): void {
      if (document.visibilityState === 'visible') void run();
    }

    refreshRef.current = () => void run();
    document.addEventListener('visibilitychange', onVisibility);
    void run();
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      refreshRef.current = () => undefined;
    };
    // `deps` las da quien llama (como en useEffect).
  }, [enabled, intervalMs, maxIntervalMs, ...deps]);

  return useCallback(() => refreshRef.current(), []);
}
