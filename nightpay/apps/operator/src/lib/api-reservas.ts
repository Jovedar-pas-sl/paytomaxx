// Reservados en la app del personal: la puerta (leer el QR, cobrar el resto,
// dar la llegada) y la barra (gastar del paquete con el QR de una persona).

import type { ReservationView } from '@nightpay/contracts';
import { authedFetch, operatorApiError } from './api';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';

export interface ScannedReservation {
  reservation: ReservationView;
  guest: { id: string; seq: number };
}

async function call<T>(path: string, body: unknown, context: string): Promise<T> {
  const res = await authedFetch(path, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw await operatorApiError(res, context);
  return res.json() as Promise<T>;
}

export const scanReservation = (qr: string) => call<ScannedReservation>('/v1/reservations/scan', { qr }, 'Leer el QR del reservado');

export const arriveReservation = (id: string, guestId?: string) =>
  call<ReservationView>(`/v1/reservations/${id}/arrive`, guestId ? { guestId } : {}, 'Dar la llegada');

/** «Cobrar el resto»: el cobro con tarjeta del 70 %; su enlace entero, para el QR. */
export async function collectRest(id: string): Promise<{ payUrl: string }> {
  const out = await call<{ payUrl: string }>(`/v1/reservations/${id}/rest`, {}, 'Cobrar el resto');
  return { payUrl: new URL(out.payUrl, API_BASE).toString() };
}

export const chargeReservation = (guestToken: string, amountCents: number, key: string) =>
  call<ReservationView>('/v1/reservations/charge', { guestToken, amountCents, key }, 'Cobrar del reservado');

export const serveReservation = (guestToken: string, itemName: string, qty: number, key: string) =>
  call<ReservationView>('/v1/reservations/serve', { guestToken, itemName, qty, key }, 'Servir del reservado');

export async function fetchReservation(id: string): Promise<ReservationView> {
  const res = await authedFetch(`/v1/reservations/${id}`);
  if (!res.ok) throw await operatorApiError(res, 'Ver el reservado');
  return res.json() as Promise<ReservationView>;
}
