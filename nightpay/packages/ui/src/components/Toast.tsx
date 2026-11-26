'use client';

import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { TOAST_ACTION_MS, TOAST_MS, toastBottom, toastStore, type ToastOptions } from '../lib/toast';
import { Icon } from './Icon';

/** Los pies fijos de una pantalla: el aviso se pone encima del más alto. */
const FEET = '[data-np-foot], .np-outcome-actions';

const api = {
  /**
   * Algo que salió bien, o un «Deshacer»: `toast.show('Ficha devuelta', { action: { label: 'Deshacer', onClick: undo } })`.
   * Se va solo a los 5 s (10 con botón) y el nuevo sustituye al anterior. Nunca un error.
   */
  show: (text: string, options?: ToastOptions): void => toastStore.show(text, options),
  dismiss: (): void => toastStore.dismiss(),
};

/** `const toast = useToast()`: siempre el mismo objeto (vale como dependencia de un efecto). */
export function useToast(): typeof api {
  return api;
}

/**
 * El aviso flotante de la app: va UNA vez, en el layout. La región está
 * siempre (un lector de pantalla la escucha) y vacía hasta que alguien llama a
 * useToast().show(). Estilos en pieces-2.css: .np-toast.
 */
export function Toast() {
  const item = useSyncExternalStore(toastStore.subscribe, toastStore.get, () => null);
  const [bottom, setBottom] = useState<number | null>(null);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const held = hover || focus;

  // Al salir: su sitio, 16 px sobre el pie fijo más alto de la pantalla (sin pie, el del CSS).
  useLayoutEffect(() => {
    if (!item) return;
    setHover(false);
    setFocus(false);
    const feet = Array.from(document.querySelectorAll(FEET), (el) => el.getBoundingClientRect());
    setBottom(toastBottom(feet, window.innerHeight));
  }, [item]);

  // El reloj. El ratón encima (no el dedo) o el foco dentro lo paran; al irse, vuelve a contar.
  useEffect(() => {
    if (!item || held) return undefined;
    const timer = setTimeout(() => toastStore.dismiss(item.key), item.action ? TOAST_ACTION_MS : TOAST_MS);
    return () => clearTimeout(timer);
  }, [item, held]);

  return (
    <div className="np-toast-region" role="status" aria-live="polite" style={bottom === null ? undefined : { bottom }}>
      {item ? (
        <div
          key={item.key}
          className="np-toast"
          data-tone={item.tone}
          // Solo el ratón: en un móvil, tocar el aviso no lo deja clavado (sin «salir» nunca volvería a contar).
          onPointerEnter={(e) => setHover(e.pointerType === 'mouse')}
          onPointerLeave={() => setHover(false)}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
        >
          <Icon name={item.tone === 'success' ? 'check' : 'info'} size={20} />
          <span className="np-toast-text">{item.text}</span>
          {item.action ? (
            <button
              type="button"
              className="np-toast-action"
              onClick={() => {
                item.action?.onClick();
                toastStore.dismiss(item.key);
              }}
            >
              {item.action.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
