'use client';

import { useEffect, useState } from 'react';
import type { ChipVia } from '@/lib/chip-tap';
import { callReader, hasBridgeMethod } from '@/lib/pax-bridge';
import { readerErrorText } from '@/lib/pax-saldo';
import { nfcSupported } from '@/lib/nfc';

export interface ChipReader {
  /** Por dónde se leen las fichas (null: aquí no se puede). */
  via: ChipVia | null;
  /** Se pueden grabar fichas en blanco (la app del datáfono 0.3+ o Web NFC). */
  canWrite: boolean;
  /** Por qué no (null si se puede). */
  note: string | null;
  /** Aún se está mirando. */
  loading: boolean;
}

/**
 * ¿Cómo se leen y graban fichas aquí? En el datáfono, por el NFC de su app
 * (si el lector de tarjetas no lo tiene reservado); en un Android, con Web NFC.
 */
export function useChipReader(): ChipReader {
  const [reader, setReader] = useState<ChipReader>({ via: null, canWrite: false, note: null, loading: true });
  useEffect(() => {
    let alive = true;
    const web = nfcSupported();
    if (!hasBridgeMethod('capabilities')) {
      setReader({
        via: web ? 'web' : null,
        canWrite: web,
        note: web ? null : 'Este móvil no lee fichas desde la app: hace falta un Android con Chrome (o el datáfono).',
        loading: false,
      });
      return undefined;
    }
    void callReader('capabilities').then((r) => {
      if (!alive) return;
      const nfc = r.ok ? (r.nfc ?? 'unavailable') : 'unavailable';
      if (nfc === 'ready') {
        const canWrite = hasBridgeMethod('writeNfc');
        setReader({
          via: 'bridge',
          canWrite,
          note: canWrite ? null : 'Esta app del datáfono lee fichas pero no las graba: pide que la actualicen.',
          loading: false,
        });
        return;
      }
      setReader({
        via: web ? 'web' : null,
        canWrite: web,
        note: web ? null : readerErrorText(nfc === 'disabled' ? 'nfcDisabled' : 'nfcUnavailable'),
        loading: false,
      });
    });
    return () => {
      alive = false;
    };
  }, []);
  return reader;
}
