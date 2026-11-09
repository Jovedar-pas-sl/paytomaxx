// Cobros: métricas, lista, devoluciones, resolver atascados e informes CSV.

import type { ApprovalRequestedResponse } from '@nightpay/contracts';
import { apiError, authedFetch, totpAwareError } from '../http';
import { refundIntentKey, settleRefundIntent, settlesRefundIntent } from '../refund-intent';

export interface PaymentRow {
  id: string;
  amountCents: number;
  availableAmountCents: number;
  currency: string;
  status: string;
  provider: string | null;
  providerTxId: string | null;
  createdAt: string;
  updatedAt: string;
  // Datos del banco (Fase 0). Null en cobros antiguos o sin aviso.
  authCode?: string | null;
  cardLast4?: string | null;
  cardBrand?: string | null;
  payMethodCode?: string | null;
  authorizedAt?: string | null;
  /**
   * «Comisión del servicio» que pagó el cliente encima (ya en lo devolvible de
   * un pago directo; en una recarga, no se devuelve). Un API de antes no la manda.
   */
  serviceFeeCents?: number;
  /** La propina que se cobró (para repartir lo devuelto). Un API de antes no la manda. */
  tipCents?: number;
  /** El saldo que recargó (una recarga); null en un pago directo. */
  walletId?: string | null;
  // Fase 1B: total y propina que se mandaron al banco en cada intento (null = antes de 1B).
  attempts?: Array<{
    providerTxId: string;
    status: string;
    createdAt: string;
    amountCents?: number | null;
    tipCents?: number | null;
  }>;
  terminal: { externalId: string; label: string };
}

export interface MetricsPeriod {
  count: number;
  /** Sin propinas. */
  grossCents: number;
  refundedCents: number;
  /** API nuevo: cobrado − devoluciones − saldo devuelto en efectivo, con propinas. */
  netCents: number;
  /** API nuevo: propinas y cobrado (importe + propina). El API antiguo no los manda. */
  tipCents?: number;
  chargedCents?: number;
  walletCashPayoutCents?: number;
  /** API nuevo: recargas del saldo en efectivo (en chargedCents) y con tarjeta (en grossCents y count). */
  walletCashTopUpCents?: number;
  walletCardTopUpCents?: number;
  /** «Comisión del servicio» cobrada (ya en chargedCents; se debe a OxioPay). Sin ella, no viene. */
  serviceFeeCents?: number;
}

export interface Metrics {
  today: MetricsPeriod;
  week: MetricsPeriod;
  statusBreakdown: Record<string, number>;
}

export interface Refund {
  id: string;
  paymentId: string;
  amountCents: number;
  reason: string | null;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  providerRefundId: string | null;
  createdAt: string;
}

export async function fetchMetrics(): Promise<Metrics> {
  const res = await authedFetch('/v1/admin/metrics');
  if (!res.ok) throw new Error('Error cargando métricas');
  return res.json();
}

export async function fetchPayments(params: {
  status?: string[];
  cursor?: string;
  limit?: number;
}): Promise<{ items: PaymentRow[]; nextCursor: string | null }> {
  const qs = new URLSearchParams();
  if (params.status && params.status.length) qs.set('status', params.status.join(','));
  if (params.cursor) qs.set('cursor', params.cursor);
  if (params.limit) qs.set('limit', String(params.limit));
  const res = await authedFetch(`/v1/admin/payments?${qs.toString()}`);
  if (!res.ok) throw new Error('Error cargando pagos');
  return res.json();
}

export async function fetchRefunds(paymentId: string): Promise<Refund[]> {
  const res = await authedFetch(`/v1/payments/${encodeURIComponent(paymentId)}/refunds`);
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/**
 * Devolución que quedó PENDIENTE porque la pasarela no confirmó: el dueño la
 * mira en el portal y la marca hecha o no hecha (pasados 2 minutos).
 */
export async function resolvePendingRefund(
  paymentId: string,
  refundId: string,
  input: { outcome: 'SUCCEEDED' | 'FAILED'; note: string },
): Promise<{ id: string; status: string }> {
  const res = await authedFetch(
    `/v1/payments/${encodeURIComponent(paymentId)}/refunds/${encodeURIComponent(refundId)}/resolve`,
    { method: 'POST', body: JSON.stringify(input) },
  );
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/**
 * Devolución por la pasarela. Si el encargado pide desde el umbral del local,
 * el API no la hace: responde 202 «pedido al dueño» (isApprovalRequested).
 * Lleva la clave de la devolución de este cobro aún sin respuesta
 * (refund-intent): un reintento recupera la primera, nunca devuelve dos veces.
 * `replayed`: era esa misma, ya hecha antes.
 */
export async function refundPayment(
  paymentId: string,
  amountCents: number,
  reason?: string,
  totpCode?: string,
): Promise<{ id: string; status: string; providerRefundId: string | null; replayed?: boolean } | ApprovalRequestedResponse> {
  const idempotencyKey = refundIntentKey(paymentId);
  try {
    const res = await authedFetch(`/v1/payments/${paymentId}/refunds`, {
      method: 'POST',
      body: JSON.stringify({ amountCents, reason, totpCode, idempotencyKey }),
    });
    if (!res.ok) throw await totpAwareError(res);
    const result = await res.json();
    settleRefundIntent(paymentId, idempotencyKey);
    return result;
  } catch (err) {
    // Sin respuesta (red), sin confirmar en la pasarela o aún en curso: la
    // clave se queda para el siguiente intento. Rechazada o ya decidida: no.
    if (settlesRefundIntent(err)) settleRefundIntent(paymentId, idempotencyKey);
    throw err;
  }
}

/**
 * Resolver a mano un pago atascado (sin confirmar, o >15 min esperando al
 * banco). Para darlo por cobrado hace falta el código de autorización del banco.
 */
export async function resolveStuckPayment(
  paymentId: string,
  input: { decision: 'AUTHORIZED' | 'FAILED'; reason: string; bankAuthCode?: string; bankOrder?: string; totpCode?: string },
): Promise<{ ok: true; newStatus: string }> {
  const res = await authedFetch(`/v1/admin/payments/${paymentId}/manual-reconcile`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await totpAwareError(res);
  return res.json();
}

/** Fase 1C — devolución ya hecha en el portal de BBVA (no mueve dinero). */
export interface BankRefundInput {
  amountCents: number;
  reason: string;
  bankReference?: string;
  /** AAAA-MM-DD */
  refundedOn?: string;
  confirmDuplicate?: boolean;
}

export async function registerBankRefund(
  paymentId: string,
  input: BankRefundInput,
): Promise<{ id: string; status: string }> {
  const res = await authedFetch(`/v1/payments/${paymentId}/refunds/bank`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/** Fase 1C — informes para la gestoría (CSV). */
export type ExportKind = 'cobros' | 'devoluciones' | 'liquidaciones' | 'resumen' | 'recargas-efectivo' | 'saldo-devuelto';

export async function downloadExport(kind: ExportKind, from: string, to: string): Promise<Blob> {
  const qs = new URLSearchParams({ from, to }).toString();
  const res = await authedFetch(`/v1/admin/export/${kind}?${qs}`);
  if (!res.ok) throw await apiError(res);
  return res.blob();
}
