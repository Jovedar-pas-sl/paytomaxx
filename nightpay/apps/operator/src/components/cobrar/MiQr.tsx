'use client';

import { useEffect, useState } from 'react';
import { Icon, ScreenHelp, useWakeLock } from '@nightpay/ui';
import type { StaffQrView } from '@nightpay/contracts';
import { fetchMyStaffQr } from '@/lib/api';
import { formatEur } from '@/lib/money';
import { TOURS } from '@/lib/tours';
import { Chip, ScreenHeader } from './ScreenHeader';
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
  forService = false,
}: {
  name: string;
  /** Sus invitaciones de esta noche (null: aún no se sabe). */
  invitations: { count: number; shareCents: number } | null;
  onClose: () => void;
  /** Con la casilla apagada («Hoy cobra el encargado»): el mismo QR sirve para cobrarle el servicio. */
  forService?: boolean;
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
          subtitle={forService ? 'Para que te cobren el servicio o te inviten' : 'Para que te inviten'}
          onBack={onClose}
          chip={<Chip>{name}</Chip>}
          help={<ScreenHelp {...(forService ? TOURS.miQrServicio : TOURS.miQr)} />}
        />
        <div className={styles.myqr}>
          <div className={styles.me}>{name}</div>
          <div className={styles.qrBig} data-tour="miqr-codigo">
            {qr ? <img src={qr.qrPngDataUrl} alt={forService ? `QR de ${name}` : `QR de ${name} para las invitaciones`} /> : null}
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
            <p className={styles.muted}>
              {forService
                ? 'Enséñaselo al encargado cuando te cobre un servicio, o al camarero cuando te inviten.'
                : 'Enséñaselo al camarero cuando te inviten.'}
            </p>
          )}
          <div className={styles.tonight} data-tour="miqr-noche">
            <span className={styles.ring}>
              <svg viewBox="0 0 36 36" aria-hidden="true">
                <circle className={styles.rb} cx="18" cy="18" r="15" fill="none" strokeWidth="4" />
{/* Con 0 invitaciones no se dibuja: el extremo redondo dejaría un punto suelto en el aro. */}
                {dash > 0 ? (
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
                ) : null}
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
        <p className={styles.note} data-tour="miqr-brillo">
          <Icon name="sun" size={20} />
          Sube el brillo al máximo
        </p>
      </div>
    </div>
  );
}
