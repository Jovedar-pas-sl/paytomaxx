'use client';

import type { PartyCashDesk } from '@nightpay/contracts';
import { cashDeskLine } from '@/lib/party-cash-desk';
import s from './party.module.css';

/**
 * OxioParty · «Efectivo en esta caja» en la taquilla. Sin el dato (no ha
 * llegado o falló), nada. Por encima del aviso del organizador, en ámbar y
 * con lo que hay que hacer.
 */
export function CashDeskLine({ desk }: { desk: PartyCashDesk | null }) {
  const line = cashDeskLine(desk);
  if (!line) return null;
  return (
    <div className={s.cashDesk} data-over={line.over ? 'true' : undefined} role="status">
      <p className={s.cashDeskRow}>
        <span>Efectivo en esta caja</span>
        <b>{line.value}</b>
      </p>
      {line.over ? <p className={s.cashDeskNote}>Hay mucho efectivo: avisa al encargado para retirarlo.</p> : null}
    </div>
  );
}
