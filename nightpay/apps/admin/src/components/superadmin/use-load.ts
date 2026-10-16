'use client';

import { useCallback, useEffect, useState, type DependencyList, type Dispatch, type SetStateAction } from 'react';
import { keepIfSame } from '@/lib/diff';

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Volver a pedirlo (botón «Reintentar» o tras un cambio). */
  reload: () => void;
  /** Poner lo que devolvió una escritura sin volver a pedirlo. */
  setData: Dispatch<SetStateAction<T | null>>;
}

/**
 * Pide datos al montar y cuando cambian `deps`. Una respuesta vieja que llega
 * tarde no pisa la nueva (se aborta). Las llamadas tienen tope de tiempo
 * (lib/endpoints/superadmin), así que «Cargando…» siempre acaba en datos o
 * en error con «Reintentar».
 */
export function useLoad<T>(load: (signal: AbortSignal) => Promise<T>, deps: DependencyList): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    load(controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setData((prev) => keepIfSame(prev, next));
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'No se pudo cargar.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // `deps` las da quien llama (como en useEffect).
  }, [...deps, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { data, error, loading, reload, setData };
}

/** Búsquedas al teclear: el valor tras `ms` sin cambios (no una petición por letra). */
export function useDebounced<T>(value: T, ms = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}
