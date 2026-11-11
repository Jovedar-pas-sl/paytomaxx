'use client';

import { useEffect, useRef, useState } from 'react';
import { COUNT_UP_MS, countUpValue } from './count-up';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * La cifra que se enseña para un `target` que cambia: la primera vez sale tal
 * cual (sin subir desde cero); en los cambios siguientes cuenta del valor que
 * se veía al nuevo en medio segundo. `null` = no hay cifra todavía.
 */
export function useCountUp(target: number | null, durationMs: number = COUNT_UP_MS): number | null {
  const [shown, setShown] = useState<number | null>(target);
  const current = useRef<number | null>(target);

  useEffect(() => {
    const from = current.current;
    if (target === null || from === null || from === target || prefersReducedMotion()) {
      current.current = target;
      setShown(target);
      return undefined;
    }
    let frame = 0;
    const start = performance.now();
    const step = (now: number): void => {
      const t = (now - start) / durationMs;
      const value = countUpValue(from, target, t);
      current.current = value;
      setShown(value);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs]);

  return shown;
}
