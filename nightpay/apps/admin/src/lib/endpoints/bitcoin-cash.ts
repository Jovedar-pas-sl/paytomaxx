// Devolver en efectivo lo pagado con bitcoin (el bitcoin se queda en la
// cartera del local; el cliente recibe euros de la caja). Solo el encargado y
// el dueño, y si el local lo tiene encendido (Ajustes → Bitcoin).

import type { ApprovalRequestedResponse, BitcoinCashConfig, BitcoinCashDone, BitcoinCashRefundDto } from '@nightpay/contracts';
import { apiError, authedFetch, totpAwareError } from '../http';

/** Apagado (o un API de antes, o el servidor sin bitcoin): sin botones. */
export const BITCOIN_CASH_OFF: BitcoinCashConfig = { enabled: false, approvalAboveCents: null, days: 7, maxCents: 99_999 };

export async function fetchBitcoinCashConfig(): Promise<BitcoinCashConfig> {
  try {
    const res = await authedFetch('/v1/bitcoin-cash/config');
    if (!res.ok) return BITCOIN_CASH_OFF;
    return (await res.json()) as BitcoinCashConfig;
  } catch {
    return BITCOIN_CASH_OFF;
  }
}

export type BitcoinCashResult = BitcoinCashDone | ApprovalRequestedResponse;

/** Un cobro pagado con bitcoin. Pasado el umbral, el API lo pide al dueño (202). */
export async function refundPaymentInCash(paymentId: string, body: BitcoinCashRefundDto): Promise<BitcoinCashResult> {
  const res = await authedFetch(`/v1/payments/${encodeURIComponent(paymentId)}/bitcoin-cash-refund`, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw await totpAwareError(res);
  return res.json();
}

/** El bitcoin que llegó sin cobro (su factura de BTCPay). */
export async function returnInvoiceInCash(invoiceId: string, body: BitcoinCashRefundDto): Promise<BitcoinCashResult> {
  const res = await authedFetch(`/v1/btcpay/invoices/${encodeURIComponent(invoiceId)}/cash-return`, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw await totpAwareError(res);
  return res.json();
}

/** «Entregado»: lo aprobado por el dueño sale ahora de la caja. */
export async function handOverCash(approvalId: string): Promise<BitcoinCashDone> {
  const res = await authedFetch(`/v1/approvals/${encodeURIComponent(approvalId)}/handed`, { method: 'POST' });
  if (!res.ok) throw await apiError(res);
  return res.json();
}
