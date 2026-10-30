'use client';

import { useEffect, useState } from 'react';
import type { OperatorUser } from '@/lib/api';
import { fetchPendingTopUps } from '@/lib/api-noche';
import { useVenueMethods } from '@/lib/venue-methods';
import s from './desk/desk.module.css';
import { ReceptionDesk } from './desk/ReceptionDesk';
import { GiveFicha } from './GiveFicha';
import { PendingTopUps } from './PendingTopUps';
import { PrepareFichas } from './PrepareFichas';
import { useChipReader } from './use-chip-via';

interface Props {
  user: OperatorUser;
  /** La pestaña se ve (el NFC solo se escucha entonces). */
  active: boolean;
  /** Si la recepción pinta su propia cabecera (el mostrador) o no («Preparar fichas», las pendientes). */
  onOwnHeader?: (own: boolean) => void;
}

/**
 * Recepción desde el móvil del personal (solo quien carga saldos: recepción,
 * el encargado o el dueño). La recepción exprés (Entrada / Salida) y, debajo,
 * lo de siempre: «Preparar fichas» para el stock (Android con Chrome) y las
 * recargas cobradas sin el NFC del cliente, pendientes de asignar.
 */
export function ReceptionTab({ user, active, onOwnHeader }: Props) {
  const methods = useVenueMethods();
  const reader = useChipReader();
  const [view, setView] = useState<'desk' | 'prepare' | 'pending' | 'ficha'>('desk');
  const [pending, setPending] = useState(0);

  // El mostrador lleva su cabecera (con el menú del logo); lo de dentro, la de arriba.
  useEffect(() => {
    onOwnHeader?.(view === 'desk');
  }, [view, onOwnHeader]);

  // Al volver a la recepción, cuántas recargas esperan su saldo (si falla, el enlace sale igual).
  useEffect(() => {
    if (view !== 'desk' || !active) return undefined;
    let alive = true;
    fetchPendingTopUps()
      .then((rows) => alive && setPending(rows.length))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [view, active]);

  if (view === 'prepare') return <PrepareFichas on="staff" onDone={() => setView('desk')} />;
  if (view === 'pending') return <PendingTopUps onDone={() => setView('desk')} />;
  // El saldo cargado desde casa (o cualquiera sin ficha): su ficha, con su QR o su código y su PIN.
  if (view === 'ficha') return <GiveFicha user={user} onDone={() => setView('desk')} />;

  const canPrepare = methods.nfc && reader.via !== null && reader.canWrite;
  const footer = (
    <div className={s.links}>
      {canPrepare ? (
        <button type="button" className={s.txtlink} onClick={() => setView('prepare')}>
          Preparar fichas
        </button>
      ) : null}
      <button type="button" className={`${s.txtlink} ${pending > 0 ? s.txtlinkOn : ''}`} onClick={() => setView('pending')}>
        {pending > 0 ? `Pendientes de asignar (${pending})` : 'Pendientes de asignar'}
      </button>
      {methods.nfc ? (
        <button type="button" className={s.txtlink} onClick={() => setView('ficha')}>
          Dar ficha a un saldo
        </button>
      ) : null}
    </div>
  );
  return <ReceptionDesk user={user} active={active} footer={footer} />;
}
