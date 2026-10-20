'use client';

import { useEffect, useState } from 'react';

/**
 * ¿Se ve este elemento? Las pestañas de abajo siguen montadas al cambiar de
 * una a otra (con `hidden`): una pantalla escondida no debe escuchar el NFC
 * (lo usaría a la vez que la que se ve). Sin ResizeObserver, se da por visto.
 */
export function useShown(): [(el: HTMLElement | null) => void, boolean] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [shown, setShown] = useState(true);
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const check = () => setShown(el.getClientRects().length > 0);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [setEl, shown];
}
