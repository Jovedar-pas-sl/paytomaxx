// Recepción → Incidencias: los «El cliente dice que no ha sido él» del local
// (el cliente pulsó «No he sido yo» en el aviso de un cobro de su móvil). Los
// ve y los cierra con su nota quien carga saldos; desbloquear el PIN del
// cliente sigue siendo del encargado (panel → Saldos).

import { authedFetch, parseOperatorApiError } from './api';

export interface ReceptionIncident {
  kind: 'wallet_charge_disputed';
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

/** «16/11 · 23:40» (hora de Madrid). */
export function incidentWhen(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Madrid' });
  const time = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' });
  return `${day} · ${time}`;
}

export async function fetchReceptionIncidents(): Promise<ReceptionIncident[]> {
  const res = await authedFetch('/v1/incidents/recepcion');
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Incidencias'));
  const body = (await res.json()) as { items?: ReceptionIncident[] };
  return body.items ?? [];
}

/** Cerrarla con la nota de qué se hizo (queda en el registro). */
export async function closeReceptionIncident(refId: string, note: string): Promise<void> {
  const res = await authedFetch('/v1/incidents/recepcion/ack', {
    method: 'POST',
    body: JSON.stringify({ refId, note: note.trim() }),
  });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Incidencias'));
}
