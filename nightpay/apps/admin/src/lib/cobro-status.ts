// El estado de un cobro en las tablas del panel: una sola forma (la etiqueta
// del panel) y una palabra por estado, la misma para el cobro con tarjeta y el
// del saldo. Pura: se prueba sin pantalla (cobro-status.test.ts).

import type { CobroRow } from '@nightpay/contracts';
import type { Tone } from '@/components/Pill';

export interface CobroStatusView {
  label: string;
  tone: Tone;
}

const CARD: Readonly<Record<string, CobroStatusView>> = {
  AUTHORIZED: { label: 'Pagado', tone: 'success' },
  PARTIALLY_REFUNDED: { label: 'Devuelto en parte', tone: 'warning' },
  REFUNDED: { label: 'Devuelto', tone: 'neutral' },
  CANCELED: { label: 'Cancelado', tone: 'neutral' },
  FAILED: { label: 'Rechazado', tone: 'danger' },
  EXPIRED: { label: 'Caducado', tone: 'neutral' },
  AUTHORIZING: { label: 'Esperando pago', tone: 'info' },
  AWAITING_CAPTURE: { label: 'En el datáfono', tone: 'info' },
  CREATED: { label: 'Sin pagar', tone: 'neutral' },
  ORPHAN: { label: 'Sin confirmar', tone: 'warning' },
};

/** «Pagado», «Cancelado», «Devuelto»…: lo mismo en todas las filas. */
export function cobroStatus(row: Pick<CobroRow, 'kind' | 'status'>): CobroStatusView {
  if (row.kind === 'SALDO') return row.status === 'REVERSED' ? { label: 'Anulado', tone: 'neutral' } : CARD.AUTHORIZED!;
  return CARD[row.status] ?? { label: String(row.status), tone: 'neutral' };
}
