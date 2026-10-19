// Clientes → Fichas: lo que enseña el panel de cada ficha y de cada noche.
// Sin React: se prueba solo (fichas.test.ts).

import {
  WALLET_CARD_STATUS_LABEL,
  cardPanelActionProblem,
  type FichasNight,
  type WalletCardRow,
  type WalletCardStatus,
} from '@nightpay/contracts';
import type { Tone } from '../components/Pill';

export const FICHA_STATUS_TONE: Readonly<Record<WalletCardStatus, Tone>> = {
  STOCK: 'info',
  ISSUED: 'success',
  RETURNED: 'neutral',
  LOST: 'warning',
  BLOCKED: 'danger',
};

export function fichaStatusLabel(status: WalletCardStatus): string {
  return WALLET_CARD_STATUS_LABEL[status] ?? status;
}

export const FICHA_STATUS_FILTERS: ReadonlyArray<{ value: WalletCardStatus | ''; label: string }> = [
  { value: '', label: 'Todas' },
  { value: 'STOCK', label: 'En stock' },
  { value: 'ISSUED', label: 'Entregadas' },
  { value: 'RETURNED', label: 'Devueltas' },
  { value: 'LOST', label: 'Perdidas' },
  { value: 'BLOCKED', label: 'Bloqueadas' },
];

/** «04:A2:3B:5C» (de dos en dos, como lo enseña el lector); sin número de serie, «—». */
export function formatUid(uid: string | null): string {
  if (!uid) return '—';
  return (uid.match(/.{1,2}/g) ?? [uid]).join(':');
}

/** Lo que se escribe en el buscador, tal cual va al API (sin espacios de más; máx. 64). */
export function fichaQuery(input: string): string {
  return input.trim().slice(0, 64);
}

/** La última cosa que le pasó a la ficha (para la columna «Desde»). */
export function fichaSince(row: WalletCardRow): string | null {
  switch (row.status) {
    case 'ISSUED':
      return row.linkedAt;
    case 'RETURNED':
      return row.returnedAt;
    case 'LOST':
      return row.lostAt;
    case 'BLOCKED':
      return row.blockedAt;
    default:
      return row.stockedAt;
  }
}

/** Qué botones salen: bloquear y marcar perdida, si se puede. */
export function fichaActions(row: WalletCardRow): { block: boolean; lost: boolean } {
  return {
    block: cardPanelActionProblem(row.status, 'block') === null,
    lost: cardPanelActionProblem(row.status, 'lost') === null,
  };
}

/** La pregunta antes de tocar la ficha. */
export function fichaConfirmText(row: WalletCardRow, action: 'block' | 'lost'): string {
  const who = row.walletCode ? ` (del saldo ${row.walletCode})` : '';
  const which = row.uid ? `la ficha ${formatUid(row.uid)}` : `la ficha ${row.tokenHint}…`;
  return action === 'lost'
    ? `¿Marcar ${which}${who} como perdida? Ya no servirá para pagar y sale del stock. El saldo sigue (código + PIN).`
    : `¿Bloquear ${which}${who}? Ya no servirá para pagar. El saldo sigue (código + PIN).`;
}

/** Una noche en la tabla: «12 → 3 devueltas · 1 perdida». El stock, si se sabe. */
export function nightStockText(n: FichasNight): string {
  return n.enStock === null ? '—' : String(n.enStock);
}

/** ¿Se perdieron más fichas de las que volvieron? (para avisar en la fila). */
export function nightLosesFichas(n: FichasNight): boolean {
  return n.perdidas > 0;
}
