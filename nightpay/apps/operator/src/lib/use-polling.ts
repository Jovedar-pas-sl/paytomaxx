import { useCallback, useEffect, useRef } from 'react';
import { createPoller, type Poller, type PollOutcome } from './poller';

export interface PollingOptions {
  intervalMs: number;
  /** Pausa tras un fallo (servidor caído, 429). Por defecto, el triple. */
  slowIntervalMs?: number;
  /** false: parado (p. ej. mientras no hace falta). */
  enabled?: boolean;
  /** Retraso de la primera vuelta (0: al montar). */
  initialDelayMs?: number;
}

const isHidden = (): boolean => document.visibilityState === 'hidden';

/**
 * Refresca algo cada `intervalMs` (ver createPoller): sin solapar peticiones,
 * sin preguntar con la pantalla oculta y preguntando nada más volver a verse.
 * Usa siempre la última versión de `task` (nada de estado viejo atrapado en
 * el intervalo). Devuelve cómo pedir una vuelta ya.
 */
export function usePolling(
  task: () => Promise<PollOutcome>,
  { intervalMs, slowIntervalMs, enabled = true, initialDelayMs = 0 }: PollingOptions,
): () => void {
  const taskRef = useRef(task);
  const pollerRef = useRef<Poller | null>(null);

  useEffect(() => {
    taskRef.current = task;
  });

  useEffect(() => {
    if (!enabled) return undefined;
    const poller = createPoller({ task: () => taskRef.current(), intervalMs, slowIntervalMs, isHidden });
    pollerRef.current = poller;
    const onVisibility = () => {
      if (!isHidden()) poller.poke();
    };
    document.addEventListener('visibilitychange', onVisibility);
    poller.start(initialDelayMs);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      poller.stop();
      if (pollerRef.current === poller) pollerRef.current = null;
    };
  }, [enabled, intervalMs, slowIntervalMs, initialDelayMs]);

  return useCallback(() => pollerRef.current?.poke(), []);
}
