'use client';

import { useEffect } from 'react';
import { useToast } from '@nightpay/ui';
import { nfcHub } from '@/lib/nfc';
import { IDLE_TAP_TEXT } from '@/lib/nfc-hub';

/**
 * La escucha NFC de toda la app (una sola, lib/nfc-hub): con el permiso NFC ya
 * dado arranca al abrir la app; si no, con el primer «Acercar» de una pantalla,
 * como antes. Una ficha que se acerca sin que ninguna pantalla la espere no
 * hace nada (Android tampoco abre su enlace): solo el aviso flotante.
 */
export function NfcEscucha() {
  const toast = useToast();

  useEffect(() => {
    const hub = nfcHub();
    if (!hub) return undefined;
    void hub.startIfAllowed();
    return hub.onIdleTap(() => toast.show(IDLE_TAP_TEXT));
  }, [toast]);

  return null;
}
