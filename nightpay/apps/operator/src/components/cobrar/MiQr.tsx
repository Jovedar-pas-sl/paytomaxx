'use client';

import { useEffect, useState } from 'react';
import { useWakeLock } from '@nightpay/ui';
import type { StaffQrView } from '@nightpay/contracts';
import { fetchMyStaffQr } from '@/lib/api';
import { formatEur } from '@/lib/money';
import { Chip, ScreenHeader } from './ScreenHeader';
import { IconSun } from './icons';
import styles from './cobrar.module.css';

/** El QR se renueva antes de caducar (dura 10 minutos en el servidor). */
const REFRESH_MS = 4 * 60 * 1000;
/** Lo que llena el aro de «N invitaciones esta noche». */
const RING_FULL = 10;

/**
 * «Mi QR», en el móvil de la chica (maqueta 2.3): su nombre enorme y un QR
 * grande sobre blanco, que se lee a oscuras y a un brazo de distancia. El
 * aro cuenta sus invitaciones de la noche. La pantalla no se apaga mientras
 * está abierto; el brillo lo sube ella (una web no puede subirlo sola).
 */
export function MiQr({
  name,
  invitations,
  onClose,
}: {
  name: string;
  /** Sus invitaciones de esta noche (null: aún no se sabe). */
  invitations: { count: number; shareCents: number } | null;
  onClose: () => void;
}) {
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

  const count = invitations?.count ?? 0;
  const dash = Math.min(100, Math.round((count / RING_FULL) * 100));
  return (
    <div className={styles.overlay}>
      <div className={styles.screen}>
        <ScreenHeader
          title="Mi QR"
          subtitle="Para que te inviten"
          onBack={onClose}
          chip={<Chip>{name}</Chip>}
        />
        <div className={styles.myqr}>
          <div className={styles.me}>{name}</div>
          <div className={styles.qrBig}>
            {qr ? <img src={qr.qrPngDataUrl} alt={`QR de ${name} para las invitaciones`} /> : null}
          </div>
          {error && !qr ? (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          ) : error ? (
            <p role="status" className={styles.muted}>
              Sin conexión: este QR vale unos minutos más.
            </p>
          ) : (
            <p className={styles.muted}>Enséñaselo al camarero cuando te inviten.</p>
          )}
          <div className={styles.tonight}>
            <span className={styles.ring}>
              <svg viewBox="0 0 36 36" aria-hidden="true">
                <circle className={styles.rb} cx="18" cy="18" r="15" fill="none" strokeWidth="4" />
                <circle
                  className={styles.rf}
                  cx="18"
                  cy="18"
                  r="15"
                  fill="none"
                  strokeWidth="4"
                  strokeLinecap="round"
                  pathLength={100}
                  strokeDasharray={`${dash} 100`}
                />
              </svg>
              <span>{count}</span>
            </span>
            <div className={styles.grow}>
              <b>{count === 1 ? '1 invitación esta noche' : `${count} invitaciones esta noche`}</b>
              <span>
                {invitations && invitations.shareCents > 0
                  ? `Llevas ${formatEur(invitations.shareCents, { compact: true })} de copas`
                  : 'Aún ninguna esta noche'}
              </span>
            </div>
          </div>
        </div>
        <p className={styles.note}>
          <IconSun />
          Sube el brillo al máximo
        </p>
      </div>
    </div>
  );
}
