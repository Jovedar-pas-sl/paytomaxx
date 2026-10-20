'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { Button, useWakeLock } from '@nightpay/ui';
import type { StaffQrView } from '@nightpay/contracts';
import { fetchMyStaffQr } from '@/lib/api';

/** El QR se renueva antes de caducar (dura 10 minutos en el servidor). */
const REFRESH_MS = 4 * 60 * 1000;

/**
 * «Mi QR» de la chica: lo escanea el camarero cuando un cliente la invita a
 * una copa. Solo dice quién es (no abre su cuenta ni cobra nada) y se renueva
 * solo; la pantalla no se apaga mientras está abierto.
 */
export function StaffQrSheet({ onClose }: { onClose: () => void }) {
  const [qr, setQr] = useState<StaffQrView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useWakeLock(true);

  useEffect(() => {
    const ctrl = new AbortController();
    const load = () =>
      fetchMyStaffQr(ctrl.signal)
        .then((v) => {
          setQr(v);
          setError(null);
        })
        .catch((err: Error) => {
          if (!ctrl.signal.aborted) setError(err.message);
        });
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      ctrl.abort();
      clearInterval(timer);
    };
  }, []);

  return (
    <div style={boxStyle}>
      <p style={{ margin: 0, fontSize: '1.0625rem', fontWeight: 700, textAlign: 'center' }}>
        Para que te inviten a una copa: enséñaselo al camarero.
      </p>
      {qr ? (
        <img src={qr.qrPngDataUrl} alt="Tu QR para las invitaciones" style={qrStyle} />
      ) : (
        <p style={hint}>{error ?? 'Sacando tu QR…'}</p>
      )}
      {error && qr ? (
        <p role="status" style={hint}>
          Sin conexión: este QR vale unos minutos más.
        </p>
      ) : null}
      <Button size="lg" onClick={onClose}>
        Cerrar
      </Button>
    </div>
  );
}

const boxStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: 'var(--np-gap)',
};
const hint: CSSProperties = { margin: 0, textAlign: 'center', color: 'var(--np-text-mute)' };
const qrStyle: CSSProperties = {
  width: 'min(300px, 80vw)',
  height: 'auto',
  alignSelf: 'center',
  background: '#fff',
  padding: '0.75rem',
  borderRadius: 'var(--np-r-lg)',
};
