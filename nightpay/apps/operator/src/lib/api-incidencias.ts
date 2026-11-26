// Recepción → Incidencias: los «El cliente dice que no ha sido él» del local
// (el cliente pulsó «No he sido yo» en el aviso de un cobro de su móvil). Los
// ve y los cierra con su nota quien carga saldos; desbloquear el PIN del
// cliente sigue siendo del encargado (panel → Saldos). Y los «Pagó después
// de cancelar» (el banco cobró un cobro ya cancelado): los ve recepción y los
// cierra con su nota el encargado o el dueño (devuelto en el banco o dado por bueno).
// El encargado y el dueño ven además los «No es mío» de las compañeras
// (service_disputed): solo los cierra el dueño, en el panel. En un local sin
// saldo no hay Recepción: el encargado los ve en Avisos del panel (GET /incidents).

import { formatRelative } from '@nightpay/ui';
import { authedFetch, parseOperatorApiError } from './api';

export interface ReceptionIncident {
  kind: 'wallet_charge_disputed' | 'approval_unbooked' | 'service_disputed';
  /** false: lo ve, pero lo cierra el encargado o el dueño (sin el campo, la app de antes: sí). */
  ackable?: boolean;
  refId: string;
  title: string;
  detail: string;
  occurredAt: string;
  amountCents: number | null;
  noteRequired?: boolean;
}

/** Letras mínimas de la nota (como en el panel: es un aviso de dinero). */
export const MIN_NOTE_LENGTH = 3;

/** ¿Se puede cerrar ya con esta nota? */
export function noteReady(note: string): boolean {
  return note.trim().length >= MIN_NOTE_LENGTH;
}

/** Cuándo fue, como en toda la app: «hace 12 min», «ayer, 23:40» (hora de Madrid). */
export function incidentWhen(iso: string, now: Date = new Date()): string {
  return formatRelative(iso, now);
}

export async function fetchReceptionIncidents(): Promise<ReceptionIncident[]> {
  const res = await authedFetch('/v1/incidents/recepcion');
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Incidencias'));
  const body = (await res.json()) as { items?: ReceptionIncident[] };
  return body.items ?? [];
}

/** Cerrarla con la nota de qué se hizo (queda en el registro). */
export async function closeReceptionIncident(
  refId: string,
  note: string,
  kind: ReceptionIncident['kind'] = 'wallet_charge_disputed',
): Promise<void> {
  const res = await authedFetch('/v1/incidents/recepcion/ack', {
    method: 'POST',
    body: JSON.stringify({ kind, refId, note: note.trim() }),
  });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Incidencias'));
}
