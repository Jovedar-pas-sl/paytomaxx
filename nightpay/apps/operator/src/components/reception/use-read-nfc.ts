'use client';

import { useEffect, useMemo, useState } from 'react';
import { walletCardUrl } from '@nightpay/contracts';
import { blankCodeFrom, tapChip } from '@/lib/chip-tap';
import { staffBackend } from '@/lib/reception';
import { useChipReader, type ChipReader } from './use-chip-via';

/** B5: lo que dice la espera de la ficha cuando se corta sola. */
export const READ_TIMEOUT_TEXT = 'Ha pasado un minuto sin acercar la ficha: toca «Acercar la ficha» cuando la tengas.';

/** Cómo leer: `writeBlank`, una ficha en blanco se graba y va al stock (B5); `timeoutMs`, la espera se corta sola. */
export interface ReadOptions {
  writeBlank?: boolean;
  timeoutMs?: number;
}

export interface NfcRead {
  token: string;
  uid: string | null;
}

/**
 * Leer el NFC del cliente (tarjeta, ficha o pulsera) para saber de qué saldo
 * es: por el lector del datáfono o con Web NFC en un Android. Sin grabar nada.
 */
export function useReadNfc(): {
  reader: ChipReader;
  reading: AbortController | null;
  read: (options?: ReadOptions) => Promise<NfcRead>;
} {
  const reader = useChipReader();
  const [reading, setReading] = useState<AbortController | null>(null);
  useEffect(() => () => reading?.abort(), [reading]);
  const blank = useMemo(
    () => blankCodeFrom(() => staffBackend.newToken(), (token) => walletCardUrl(window.location.origin, token)),
    [],
  );

  async function read(options: ReadOptions = {}): Promise<NfcRead> {
    if (!reader.via) throw new Error(reader.note ?? 'Aquí no se pueden leer NFC: teclea su código.');
    const controller = new AbortController();
    setReading(controller);
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, options.timeoutMs)
      : undefined;
    try {
      const tap = await tapChip(reader.via, controller.signal, options.writeBlank && reader.canWrite ? blank : undefined);
      if (tap.other) throw new Error('Esta ficha tiene otra cosa grabada: no es de un saldo.');
      if (!tap.token) throw new Error(options.writeBlank ? (reader.note ?? 'Esta ficha está en blanco y aquí no se puede grabar: usa otra.') : 'Esta ficha no es de ningún saldo: los saldos nuevos se dan en Recepción.');
      // Recién grabada: al stock, como en «Preparar fichas».
      if (tap.written) await staffBackend.stock(tap.token, tap.uid);
      return { token: tap.token, uid: tap.uid };
    } catch (err) {
      if (timedOut) throw new Error(READ_TIMEOUT_TEXT);
      throw err;
    } finally {
      clearTimeout(timer);
      controller.abort();
      setReading(null);
    }
  }

  return { reader, reading, read };
}
