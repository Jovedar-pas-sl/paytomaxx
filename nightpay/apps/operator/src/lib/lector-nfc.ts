// «¿Dónde está el lector NFC?» de ESTE aparato (Menú → Este aparato): detrás
// (un móvil, de partida) o arriba (un datáfono de mano con el lector en la
// parte de arriba). Se guarda en el aparato (localStorage), nada va al
// servidor, y cambia dónde se pide acercar la ficha.

import { useSyncExternalStore } from 'react';
import { browserStore, type KeyValueStore } from '@nightpay/ui/device-settings';
import { WAIT_TITLE_EN } from './pin-pad';

export type ReaderSpot = 'detras' | 'arriba';

export const READER_SPOT_KEY = 'np-lector-nfc';
export const DEFAULT_READER_SPOT: ReaderSpot = 'detras';

export const READER_SPOT_CHOICES: ReadonlyArray<{ value: ReaderSpot; label: string }> = [
  { value: 'detras', label: 'Detrás' },
  { value: 'arriba', label: 'Arriba' },
];

const CHANGED = 'np-lector-nfc-changed';

/** Lo elegido en este aparato; sin ajuste (o ilegible), detrás. */
export function readReaderSpot(store: Pick<KeyValueStore, 'getItem'> | null = browserStore()): ReaderSpot {
  try {
    return store?.getItem(READER_SPOT_KEY) === 'arriba' ? 'arriba' : DEFAULT_READER_SPOT;
  } catch {
    return DEFAULT_READER_SPOT;
  }
}

/** Lo guarda en el aparato y avisa a las pantallas abiertas. */
export function writeReaderSpot(spot: ReaderSpot, store: Pick<KeyValueStore, 'setItem'> | null = browserStore()): void {
  try {
    store?.setItem(READER_SPOT_KEY, spot);
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

/** Dónde está el lector de este aparato (al pintar en el servidor, detrás). */
export function useReaderSpot(): ReaderSpot {
  return useSyncExternalStore(subscribe, () => readReaderSpot(), () => DEFAULT_READER_SPOT);
}

/** En «Esperando», junto al icono NFC: dónde acercar la ficha. */
export function nfcWayLabel(spot: ReaderSpot): string {
  return spot === 'arriba' ? 'Arriba ↑' : 'Por detrás';
}

/** La línea en inglés del cobro abierto, para el cliente (con ficha). */
export function waitTitleEnNfc(spot: ReaderSpot): string {
  return spot === 'arriba' ? 'Hold your tag to the top of the device or scan the QR' : WAIT_TITLE_EN.nfc;
}

/** «a la parte de atrás del móvil» / «a la parte de arriba del aparato». */
export function fichaPlace(spot: ReaderSpot, device: 'móvil' | 'datáfono'): string {
  return spot === 'arriba' ? 'a la parte de arriba del aparato' : `a la parte de atrás del ${device}`;
}
