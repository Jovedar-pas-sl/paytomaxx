'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { OperatorUser } from '@/lib/api';
import { fetchPendingTopUps } from '@/lib/api-noche';
import { receptionChip, useMySections } from '@/lib/sections';
import { useVenueMethods } from '@/lib/venue-methods';
import { DeskHead } from './desk/desk-parts';
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
  /** La recepción pinta su propia cabecera: siempre (Grafito: una sola en toda Recepción). */
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
  const { sections } = useMySections();

  // Una sola cabecera en toda Recepción: la del mostrador (el logo abre el
  // menú con «Salir»), también en «Preparar fichas», las pendientes y «Dar ficha».
  useEffect(() => {
    onOwnHeader?.(true);
  }, [onOwnHeader]);

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

  // Lo de dentro, con la cabecera del mostrador y sin flecha: cada pantalla vuelve con su «Volver».
  const inner = (body: ReactNode) => (
    <div className={s.screen}>
      <DeskHead title="Recepción" sub={user.displayName ?? 'Recepción'} chip={receptionChip(sections)} />
      {body}
    </div>
  );
  if (view === 'prepare') return inner(<PrepareFichas on="staff" onDone={() => setView('desk')} />);
  if (view === 'pending') return inner(<PendingTopUps onDone={() => setView('desk')} />);
  // El saldo cargado desde casa (o cualquiera sin ficha): su ficha, con su QR o su código y su PIN.
  if (view === 'ficha') return inner(<GiveFicha user={user} onDone={() => setView('desk')} />);

  const canPrepare = methods.nfc && reader.via !== null && reader.canWrite;
  // Lo secundario, junto y abajo en una sola fila (Grafito 2): los mismos tres, y las pendientes con su número.
  const footer = (
    <nav className={s.more} aria-label="Fichas y recargas pendientes">
      {canPrepare ? (
        <button type="button" className={s.moreBtn} onClick={() => setView('prepare')}>
          Preparar fichas
        </button>
      ) : null}
      <button type="button" className={`${s.moreBtn} ${pending > 0 ? s.moreBtnOn : ''}`} onClick={() => setView('pending')}>
        {pending > 0 ? `Pendientes de asignar (${pending})` : 'Pendientes de asignar'}
      </button>
      {methods.nfc ? (
        <button type="button" className={s.moreBtn} onClick={() => setView('ficha')}>
          Dar ficha a un saldo
        </button>
      ) : null}
    </nav>
  );
  return <ReceptionDesk user={user} active={active} footer={footer} />;
}
