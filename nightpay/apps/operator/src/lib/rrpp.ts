// «Tus reservas de RRPP» (/rrpp): la página del RRPP en la app del personal.
// Solo lo suyo y en su local (lo decide el servidor con la sesión).

import type { MyPromoterPage, MyPromoterReservation, MyPromoterView, ReservationStatus } from '@nightpay/contracts';
import { authedFetch, operatorApiError } from './api';
import { formatEur } from './money';

export const RRPP_PATH = '/rrpp';

/** Lo suyo como RRPP; null si no es RRPP de este local (o está de baja). */
export async function fetchMyPromoter(signal?: AbortSignal): Promise<MyPromoterView | null> {
  const res = await authedFetch('/v1/staff/me/promoter', { signal });
  if (!res.ok) throw await operatorApiError(res, 'Tus reservas de RRPP');
  return ((await res.json()) as MyPromoterPage).promoter;
}

const DAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** «sáb 21 nov» de "2026-11-21" (la noche es un día, sin hora: en UTC no se corre). */
export function nightLabel(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export function commissionText(r: Pick<MyPromoterReservation, 'commission' | 'commissionCents'>): string {
  const amount = formatEur(r.commissionCents, { compact: true });
  if (r.commission === 'EARNED') return `Tu comisión: ${amount} (ganada)`;
  if (r.commission === 'EXPECTED') return `Tu comisión: ${amount} cuando la paguen entera`;
  return 'Sin comisión';
}

export function upcomingText(n: number): string {
  if (n === 0) return 'Sin reservas para las próximas noches';
  return `${n} ${n === 1 ? 'reserva' : 'reservas'} para las próximas noches`;
}

export type RrppTone = 'success' | 'warning' | 'mute';

export function statusTone(status: ReservationStatus): RrppTone {
  if (status === 'PAID' || status === 'ARRIVED') return 'success';
  if (status === 'DEPOSIT_PAID') return 'warning';
  return 'mute';
}
