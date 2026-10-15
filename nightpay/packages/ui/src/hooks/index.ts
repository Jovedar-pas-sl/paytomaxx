// Hooks de las apps del personal (operadora y TPV). Solo en componentes de cliente.

import { useEffect, useState, useSyncExternalStore } from 'react';
import { createWakeLock, wakeLockFrom } from '../lib/wake-lock';

/** La hora, refrescada cada `intervalMs` mientras `active` (si no, se queda quieta). */
export function useNow(active = true, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/** navigator.onLine al momento (false: seguro que no hay red). En el servidor, true. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

/** true solo cuando `flag` lleva `delayMs` en true; vuelve a false al momento. */
export function useDelayedFlag(flag: boolean, delayMs: number): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!flag) {
      setSettled(false);
      return undefined;
    }
    const timer = setTimeout(() => setSettled(true), delayMs);
    return () => clearTimeout(timer);
  }, [flag, delayMs]);
  return flag && settled;
}

/**
 * Pantalla encendida mientras `active` (un cobro abierto): la pide, la vuelve
 * a pedir al volver a la página y la suelta al terminar. Donde no hay Wake
 * Lock (o no lo conceden) no hace nada.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof document === 'undefined') return undefined;
    const lock = createWakeLock({
      wakeLock: wakeLockFrom(typeof navigator === 'undefined' ? null : navigator),
      isVisible: () => document.visibilityState === 'visible',
    });
    const onVisibility = () => lock.onVisibilityChange();
    document.addEventListener('visibilitychange', onVisibility);
    lock.start();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      lock.stop();
    };
  }, [active]);
}
