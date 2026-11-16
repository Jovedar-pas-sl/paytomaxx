// «¿Cómo imprime este aparato?» (Menú → Este aparato): «Con ventana» (el
// diálogo de imprimir de Android; vale en cualquier móvil, tablet u ordenador)
// o «Directo» (con la app RawBT: un toque y sale el ticket, del largo justo; el
// datáfono con RawBT instalada). Se guarda en el aparato (localStorage), nada va al servidor.

import { useSyncExternalStore } from 'react';
import { browserStore, type KeyValueStore } from './device-settings';

export type PrintMode = 'dialog' | 'rawbt';

export const PRINT_MODE_KEY = 'np-print-mode';
export const DEFAULT_PRINT_MODE: PrintMode = 'dialog';

export const PRINT_MODE_CHOICES: ReadonlyArray<{ value: PrintMode; label: string }> = [
  { value: 'rawbt', label: 'Directo' },
  { value: 'dialog', label: 'Con ventana' },
];

const CHANGED = 'np-print-mode-changed';

/** Lo elegido en este aparato; sin ajuste (o ilegible), con el diálogo. */
export function readPrintMode(store: Pick<KeyValueStore, 'getItem'> | null = browserStore()): PrintMode {
  try {
    return store?.getItem(PRINT_MODE_KEY) === 'rawbt' ? 'rawbt' : DEFAULT_PRINT_MODE;
  } catch {
    return DEFAULT_PRINT_MODE;
  }
}

/** Lo guarda en el aparato y avisa a las pantallas abiertas. */
export function writePrintMode(mode: PrintMode, store: Pick<KeyValueStore, 'setItem'> | null = browserStore()): void {
  try {
    store?.setItem(PRINT_MODE_KEY, mode);
  } catch {
    /* sin almacenamiento: vale hasta cerrar la app */
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGED));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGED, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener('storage', onChange);
  };
}

/** Cómo imprime este aparato (al pintar en el servidor, con el diálogo). */
export function usePrintMode(): PrintMode {
  return useSyncExternalStore(subscribe, () => readPrintMode(), () => DEFAULT_PRINT_MODE);
}
