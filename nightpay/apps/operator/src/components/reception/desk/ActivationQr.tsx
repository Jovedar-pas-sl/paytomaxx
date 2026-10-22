'use client';

import { useEffect, useState } from 'react';
import { fetchActivationLink, type ActivationLink } from '@/lib/activation-link';
import { QrBox } from './QrBox';
import s from './desk.module.css';

/**
 * 4.4 (CARGADO en efectivo): el cliente que paga en efectivo no recibe el
 * enlace privado de su saldo; con este QR lo abre en su móvil y activa Face
 * ID (luego paga y ve su saldo con él). Solo si el API lo da (recién cargado
 * aquí y sin Face ID aún); si no, no sale nada.
 */
export function ActivationQr({ walletId }: { walletId: string }) {
  const [link, setLink] = useState<ActivationLink | null>(null);
  useEffect(() => {
    let alive = true;
    fetchActivationLink(walletId).then((l) => {
      if (alive) setLink(l);
    }, () => undefined);
    return () => {
      alive = false;
    };
  }, [walletId]);
  if (!link) return null;
  return (
    <div className={s.activate}>
      <QrBox value={link.url} label="QR para activar Face ID en su móvil" small />
      <div className={s.activateText}>
        <b>Activar Face ID en su móvil</b>
        <span>Que lo escanee con la cámara.</span>
      </div>
    </div>
  );
}
