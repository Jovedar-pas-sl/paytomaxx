'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { nfcHub } from '@/lib/nfc';
import { IDLE_TAP_TEXT } from '@/lib/nfc-hub';

const SHOW_MS = 2500;

/**
 * La escucha NFC de toda la app (una sola, lib/nfc-hub): con el permiso NFC ya
 * dado arranca al abrir la app; si no, con el primer «Acercar» de una pantalla,
 * como antes. Una ficha que se acerca sin que ninguna pantalla la espere no
 * hace nada (Android tampoco abre su enlace): solo el aviso.
 */
export function NfcEscucha() {
  const [shownAt, setShownAt] = useState<number | null>(null);

  useEffect(() => {
    const hub = nfcHub();
    if (!hub) return undefined;
    void hub.startIfAllowed();
    return hub.onIdleTap(() => setShownAt(Date.now()));
  }, []);

  useEffect(() => {
    if (shownAt === null) return undefined;
    const t = setTimeout(() => setShownAt(null), SHOW_MS);
    return () => clearTimeout(t);
  }, [shownAt]);

  if (shownAt === null) return null;
  return (
    <p role="status" style={toast}>
      {IDLE_TAP_TEXT}
    </p>
  );
}

// Grafito: el mismo aviso flotante que «Te han invitado» (filete y sombra del diálogo, sin lima).
const toast: CSSProperties = {
  position: 'fixed',
  top: 'calc(0.75rem + env(safe-area-inset-top, 0px))',
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 120,
  margin: 0,
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: '3rem',
  padding: '0 1.25rem',
  borderRadius: 'var(--np-r-md)',
  background: 'var(--np-surface-2)',
  color: 'var(--np-text)',
  boxShadow: 'inset 0 0 0 1px var(--np-border-hi), var(--np-shadow-2)',
  fontWeight: 500,
  fontSize: 'var(--np-fs-16)',
  whiteSpace: 'nowrap',
};
