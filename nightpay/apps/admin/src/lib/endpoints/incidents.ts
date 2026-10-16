// Incidencias (Fase 1E).

import { apiError, authedFetch } from '../http';

// ─── Incidencias (Fase 1E) ─────────────────────────────────────────

export type IncidentKind =
  | 'stuck_payment'
  | 'duplicate_charge'
  | 'earning_reverse_failed'
  | 'wallet_credit_skipped'
  | 'night_closed_pending'
  | 'pos_charge_mismatch'
  | 'pos_unmatched_op'
  | 'pos_unreconciled'
  | 'wallet_close_requested'
  | 'wallet_open_balance'
  | 'bank_mismatch'
  | 'backup_stale'
  | 'backup_unmonitored'
  | 'approval_unverified'
  | 'amount_mismatch'
  | 'approval_unbooked'
  /** Devolución PENDIENTE con el banco más de 5 min (no se marca: se quita sola al resolverla). */
  | 'refund_pending';

export interface Incident {
  kind: IncidentKind;
  refId: string;
  title: string;
  detail: string;
  occurredAt: string;
  amountCents: number | null;
  paymentId: string | null;
  ackable: boolean;
}

export async function fetchIncidents(): Promise<{ items: Incident[]; telegram: boolean }> {
  const res = await authedFetch('/v1/incidents');
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function ackIncident(input: { kind: IncidentKind; refId: string; note?: string }): Promise<void> {
  const res = await authedFetch('/v1/incidents/ack', { method: 'POST', body: JSON.stringify(input) });
  if (!res.ok) throw await apiError(res);
}

export async function sendTelegramTest(): Promise<boolean> {
  const res = await authedFetch('/v1/incidents/telegram-test', { method: 'POST', body: '{}' });
  if (!res.ok) throw await apiError(res);
  return ((await res.json()) as { sent: boolean }).sent;
}
