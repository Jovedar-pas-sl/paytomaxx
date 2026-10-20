'use client';

import { useEffect, useState } from 'react';
import type { OperatorUser } from '@/lib/api';
import { fetchPendingTopUps } from '@/lib/api-noche';
import { useVenueMethods } from '@/lib/venue-methods';
import s from './desk/desk.module.css';
import { ReceptionDesk } from './desk/ReceptionDesk';
import { PendingTopUps } from './PendingTopUps';
import { PrepareFichas } from './PrepareFichas';
import { useChipReader } from './use-chip-via';

interface Props {
  user: OperatorUser;
  /** La pestaña se ve (el NFC solo se escucha entonces). */
  active: boolean;
}

/**
 * Recepción desde el móvil del personal (solo quien carga saldos: recepción,
 * el encargado o el dueño). La recepción exprés (Entrada / Salida) y, debajo,
 * lo de siempre: «Preparar fichas» para el stock (Android con Chrome) y las
 * recargas cobradas sin el NFC del cliente, pendientes de asignar.
 */
export function ReceptionTab({ user, active }: Props) {
  const methods = useVenueMethods();
  const reader = useChipReader();
  const [view, setView] = useState<'desk' | 'prepare' | 'pending'>('desk');
  const [pending, setPending] = useState(0);

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
    </div>
  );
  return <ReceptionDesk user={user} active={active} footer={footer} />;
}
