'use client';

import { useEffect, useState } from 'react';

/**
 * ¿Sigue el bloqueo hasta `until` (epoch ms)? Al acabar se vuelve a pintar
 * solo (p. ej. el código 2FA tras un 429 del API).
 */
export function useLockActive(until: number | null): boolean {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    if (until === null) return undefined;
    const left = until - Date.now();
    if (left <= 0) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), left + 250);
    return () => clearTimeout(timer);
  }, [until]);

  return until !== null && now < until;
}
