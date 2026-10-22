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
  /** Venta anulada en el datáfono con el cobro aún pagado (se marca como revisada). */
  | 'pos_voided_paid'
  | 'wallet_close_requested'
  | 'wallet_open_balance'
  | 'bank_mismatch'
  | 'backup_stale'
  | 'backup_unmonitored'
  | 'approval_unverified'
  | 'amount_mismatch'
  | 'approval_unbooked'
  /** Devolución PENDIENTE con el banco más de 5 min (no se marca: se quita sola al resolverla). */
  | 'refund_pending'
  /** «Por aprobar» sin decidir desde hace más de 30 min (se quita sola al decidirla o caducar). */
  | 'approval_pending'
  /** Cobros dados por pagados con la palabra del datáfono, sin la prueba de Paytef (por noche). */
  | 'pos_unproven_sales'
  /** Un datáfono de recepción pasó un tope de recargas (por minuto o de 24 h). */
  | 'pos_reception_limit'
  /** Varios saldos nuevos en efectivo seguidos que juntos pasan de 1.000 € (trocear la entrega). */
  | 'cash_split_suspected'
  /** Una persona de recepción pasó su tope de efectivo devuelto en la noche (desde ahí, el encargado con su 2FA). */
  | 'reception_payout_cap'
  /** Recarga cobrada sin el NFC del cliente que aún no se ha sumado a su saldo (se quita sola al asignarla). */
  | 'wallet_topup_unassigned';

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
