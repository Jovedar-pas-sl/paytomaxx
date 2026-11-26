'use client';

// Hooks de las apps del personal (operadora y TPV). Solo en componentes de cliente.

import { useEffect, useState, useSyncExternalStore } from 'react';
import { createKiosk } from '../lib/kiosk';
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

/**
 * Pantalla completa con la salida bloqueada mientras `active` (hay sesión):
 * se pide al entrar, se recupera en el siguiente toque si se pierde y se
 * quita al salir. Donde no hay pantalla completa (iPhone) no hace nada.
 */
export function useKiosk(active: boolean): void {
  useEffect(() => {
    if (!active || typeof document === 'undefined') return undefined;
    const root = document.documentElement;
    const nav = navigator as Navigator & { keyboard?: { lock?: (keys: string[]) => Promise<void>; unlock?: () => void } };
    const native = (window as Window & { NightPayPax?: { lockApp?: (json: string) => void; unlockApp?: (json: string) => void } }).NightPayPax;
    const kiosk = createKiosk({
      isFullscreen: () => Boolean(document.fullscreenElement),
      requestFullscreen: typeof root.requestFullscreen === 'function' ? () => root.requestFullscreen() : null,
      exitFullscreen: typeof document.exitFullscreen === 'function' ? () => document.exitFullscreen() : null,
      keyboard: nav.keyboard ?? null,
      // Como métodos del objeto de la app: fuera de él, Android no los ejecuta.
      native: native
        ? { lockApp: native.lockApp ? (j) => native.lockApp!(j) : undefined, unlockApp: native.unlockApp ? (j) => native.unlockApp!(j) : undefined }
        : null,
    });
    // El navegador solo la concede dentro de un toque: el de «Entrar» suele valer; si no, el siguiente.
    const onClick = () => kiosk.enter();
    document.addEventListener('click', onClick, true);
    kiosk.enter();
    return () => {
      document.removeEventListener('click', onClick, true);
      kiosk.leave();
    };
  }, [active]);
}
