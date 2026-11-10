'use client';

import { useEffect, useState } from 'react';
import { fetchActivationLink, type ActivationLink } from '@/lib/activation-link';
import { ACTIVATION_FOR_CLIENT } from '@/lib/pin-pad';
import { QrBox } from './QrBox';
import s from './desk.module.css';
import l from './loaded.module.css';

/**
 * 4.4 (CARGADO en efectivo): el cliente que paga en efectivo no recibe el
 * enlace de su saldo; con este QR activa Face ID (o elige su PIN) en su móvil,
 * y su móvil sigue a su saldo. Es un QR de activación de UN SOLO USO y 10 min
 * (M-2), nunca el enlace del saldo: al caducar se quita, y «Otro QR» pide uno
 * nuevo (que anula el anterior) mientras el API lo dé (15 min tras la recarga).
 * Solo si el API lo da (recién cargado aquí y sin Face ID aún); si no, nada.
 */
export function ActivationQr({
  walletId,
  read,
  onOpen,
}: {
  walletId: string;
  read?: { card: string; uid: string | null } | null;
  /** B3: el QR está a la vista (con él abierto, la siguiente ficha no cierra CARGADO). */
  onOpen?: (open: boolean) => void;
}) {
  const [link, setLink] = useState<ActivationLink | null>(null);
  const [expired, setExpired] = useState(false);
  const [round, setRound] = useState(0);
  const card = read?.card ?? null;
  const uid = read?.uid ?? null;

  useEffect(() => {
    let alive = true;
    fetchActivationLink(walletId, card ? { card, uid } : null).then((l) => {
      if (!alive) return;
      setLink(l);
      setExpired(false);
    }, () => undefined);
    return () => {
      alive = false;
    };
  }, [walletId, card, uid, round]);

  useEffect(() => {
    if (!link) return undefined;
    const timer = setTimeout(() => setExpired(true), Math.max(0, Date.parse(link.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [link]);

  // B3: quien atiende sabe si el QR está a la vista; al irse la pantalla, ya no.
  const shown = link !== null && !expired;
  useEffect(() => {
    onOpen?.(shown);
  }, [shown, onOpen]);
  useEffect(() => () => onOpen?.(false), [onOpen]);

  if (!link) return null;
  if (expired) {
    return (
      <div className={l.activate}>
        <div className={l.activateText}>
          <b>El QR de activación ha caducado</b>
          <button type="button" className={s.txtlink} onClick={() => setRound((r) => r + 1)}>
            Otro QR
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className={l.activate}>
      <QrBox value={link.url} label="QR para activar Face ID en su móvil" small />
      <div className={l.activateText}>
        <b>Activar Face ID en su móvil</b>
        <span>Que lo escanee con la cámara. Vale una vez y 10 min.</span>
        {/* Para el cliente, que mira la pantalla (PS-A12). */}
        <span className={l.activateClient}>
          {ACTIVATION_FOR_CLIENT.es} · <span lang="en">{ACTIVATION_FOR_CLIENT.en}</span>
        </span>
      </div>
    </div>
  );
}
