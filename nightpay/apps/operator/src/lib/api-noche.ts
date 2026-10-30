// «Noche fácil» en la app del personal: las recargas pendientes de asignar
// (cobradas sin el NFC del cliente). Pagar con el NFC sin PIN lo hace
// Esperando (api-cobro payByNfc): la pantalla única de cobrar.

import type { AssignedTopUp, PendingTopUpView, SaldoRefDto } from '@nightpay/contracts';
import { authedFetch, parseOperatorApiError, type CreatedPayment } from './api';

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
