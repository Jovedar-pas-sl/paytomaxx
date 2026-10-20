'use client';

import { useEffect, useState } from 'react';
import { tapChip } from '@/lib/chip-tap';
import { useChipReader, type ChipReader } from './use-chip-via';

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
  read: () => Promise<NfcRead>;
} {
  const reader = useChipReader();
  const [reading, setReading] = useState<AbortController | null>(null);
  useEffect(() => () => reading?.abort(), [reading]);

  async function read(): Promise<NfcRead> {
    if (!reader.via) throw new Error(reader.note ?? 'Aquí no se pueden leer NFC: teclea su código.');
    const controller = new AbortController();
    setReading(controller);
    try {
      const tap = await tapChip(reader.via, controller.signal);
      if (tap.other) throw new Error('Este NFC tiene otra cosa grabada: no es de un saldo.');
      if (!tap.token) throw new Error('Este NFC no es de ningún saldo: los saldos nuevos se dan en Recepción.');
      return { token: tap.token, uid: tap.uid };
    } finally {
      controller.abort();
      setReading(null);
    }
  }

  return { reader, reading, read };
}
