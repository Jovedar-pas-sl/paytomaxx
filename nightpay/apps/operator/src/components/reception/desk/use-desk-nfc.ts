'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { walletCardUrl } from '@nightpay/contracts';
import { blankCodeFrom, isChipTimeout, isFatalChipError, tapChip, type ChipTap } from '@/lib/chip-tap';
import { staffBackend } from '@/lib/reception';
import { useChipReader, type ChipReader } from '../use-chip-via';

/** Tras un fallo que no es del lector (la red, un NFC que no vale), se vuelve a escuchar a este ritmo. */
const RETRY_MS = 1_200;

export interface DeskNfc {
  reader: ChipReader;
  /** El lector se paró y hace falta un toque para seguir (permiso de Web NFC, NFC apagado…). */
  stopped: string | null;
  /** Volver a escuchar tras `stopped` (desde un toque: Web NFC pide el permiso con uno). */
  restart: () => void;
}

/**
 * Escucha el NFC mientras `active`: el cliente lo acerca y llega `onTap`, sin
 * tocar nada (4.1). Con `write`, si está en blanco se le graba un código del
 * servidor en el mismo gesto (como «Preparar fichas»). Si tras una lectura la
 * pantalla sigue aquí (aquel NFC no valía), se vuelve a escuchar tras un
 * momento; si pasa al paso siguiente, `active` se apaga y se deja de escuchar.
 */
export function useDeskNfc(
  active: boolean,
  write: boolean,
  onTap: (tap: ChipTap) => Promise<void>,
  onError: (message: string) => void,
): DeskNfc {
  const reader = useChipReader();
  const [stopped, setStopped] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const handlers = useRef({ onTap, onError });
  useEffect(() => {
    handlers.current = { onTap, onError };
  });
  const blank = useMemo(
    () => blankCodeFrom(() => staffBackend.newToken(), (token) => walletCardUrl(window.location.origin, token)),
    [],
  );
  const canWrite = write && reader.canWrite;

  useEffect(() => {
    if (!active || !reader.via || stopped) return undefined;
    const via = reader.via;
    const controller = new AbortController();
    // Una espera que se corta al salir de la pantalla.
    const wait = (ms: number) =>
      new Promise<void>((done) => {
        const timer = setTimeout(done, ms);
        controller.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            done();
          },
          { once: true },
        );
      });
    async function loop(): Promise<void> {
      while (!controller.signal.aborted) {
        try {
          const tap = await tapChip(via, controller.signal, canWrite ? blank : undefined);
          if (controller.signal.aborted) return;
          // Si la pantalla sigue aquí (no valía), se vuelve a escuchar tras un momento:
          // el mismo NFC sigue apoyado y no se lee dos veces seguidas.
          await handlers.current.onTap(tap);
          await wait(RETRY_MS);
        } catch (err) {
          if ((err as Error).name === 'AbortError' || controller.signal.aborted) return;
          if (isChipTimeout(err)) continue;
          if (isFatalChipError(err)) {
            setStopped((err as Error).message || 'El NFC del móvil está parado: toca para seguir.');
            return;
          }
          // No se pudo leer o grabar (o sin red para el código): se dice y se sigue escuchando.
          handlers.current.onError((err as Error).message);
          await wait(RETRY_MS);
        }
      }
    }
    void loop();
    return () => controller.abort();
  }, [active, reader.via, canWrite, stopped, round, blank]);

  return {
    reader,
    stopped,
    restart: () => {
      setStopped(null);
      setRound((n) => n + 1);
    },
  };
}
