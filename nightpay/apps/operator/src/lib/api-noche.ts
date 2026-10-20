// «Noche fácil» en la app del personal: pagar con el NFC sin PIN y las
// recargas pendientes de asignar (cobradas sin el NFC del cliente). La lógica
// de las respuestas es pura y se prueba sola (api-noche.test.ts).

import { PIN_REQUIRED_CODE, type AssignedTopUp, type PendingTopUpView, type SaldoRefDto } from '@nightpay/contracts';
import { parseProblemDetails } from '@nightpay/api-client';
import {
  authedFetch,
  operatorErrorMessage,
  parseOperatorApiError,
  type CreatedPayment,
  type WalletChargeRequest,
} from './api';

/** Pagar con el NFC solo: pagado, o hace falta su PIN (el mismo cobro sigue libre para pagarlo con él). */
export type NfcPayResult = { kind: 'paid'; charge: WalletChargeRequest } | { kind: 'pin'; message: string };

/** La respuesta de un cobro con el NFC solo → pagado, «que ponga su PIN» o el error de siempre. */
export function nfcPayResultOf(status: number, text: string): NfcPayResult {
  if (status >= 200 && status < 300) return { kind: 'paid', charge: JSON.parse(text) as WalletChargeRequest };
  const { message, code } = parseProblemDetails(text);
  if (status === 409 && code === PIN_REQUIRED_CODE) return { kind: 'pin', message: message ?? '' };
  throw new Error(operatorErrorMessage(status, message ?? undefined, 'Cobro', code));
}

/** El cliente acerca su NFC: hasta el tope del local se cobra sin PIN (POST /v1/wallet-charges/:id/nfc). */
export async function payWalletChargeWithCard(id: string, card: string, uid: string | null): Promise<NfcPayResult> {
  const res = await authedFetch(`/v1/wallet-charges/${encodeURIComponent(id)}/nfc`, {
    method: 'POST',
    body: JSON.stringify({ card, ...(uid ? { uid } : {}) }),
  });
  return nfcPayResultOf(res.status, await res.text().catch(() => ''));
}

/** Cobrar primero, sin su NFC: recarga con tarjeta (el QR en su móvil) que queda pendiente de asignar. */
export async function startPendingTopUp(amountCents: number, idempotencyKey: string): Promise<CreatedPayment> {
  const res = await authedFetch('/v1/reception/topups/pending', {
    method: 'POST',
    body: JSON.stringify({ amountCents, idempotencyKey }),
  });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Recarga'));
  return res.json();
}

/** Las cobradas que esperan su saldo (la chica, solo las suyas). */
export async function fetchPendingTopUps(): Promise<PendingTopUpView[]> {
  const res = await authedFetch('/v1/reception/topups/pending');
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Recargas pendientes'));
  return res.json();
}

/** Asignarla: su NFC o su código dicen de qué saldo es y se suma a él. */
export async function assignPendingTopUp(walletId: string, ref: SaldoRefDto): Promise<AssignedTopUp> {
  const res = await authedFetch(`/v1/reception/topups/${encodeURIComponent(walletId)}/assign`, {
    method: 'POST',
    body: JSON.stringify(ref),
  });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Recarga pendiente'));
  return res.json();
}
