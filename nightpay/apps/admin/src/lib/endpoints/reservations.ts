// Clientes → Reservados (dueño y encargado): paquetes, la lista de la noche,
// la mesa, cambiar la fecha, anular, «No vino», el enlace web y las señales.

import type {
  CreateReservationDto,
  PromoterView,
  ReservationAccounting,
  ReservationPackageInput,
  ReservationPackageView,
  ReservationView,
} from '@nightpay/contracts';
import { apiError, authedFetch } from '../http';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authedFetch(path, init);
  if (!res.ok) throw await apiError(res);
  return res.json() as Promise<T>;
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export interface ReservationSettings {
  enabled: boolean;
  /** Hora de apertura («22:30»): las 48 h y «esta noche hasta 2 h antes» cuentan desde ella. */
  openTime: string;
  url: string | null;
}

export const fetchPackages = () => call<ReservationPackageView[]>('/v1/reservations/packages');
export const createPackage = (dto: ReservationPackageInput) => call<ReservationPackageView>('/v1/reservations/packages', post(dto));
export const updatePackage = (id: string, dto: ReservationPackageInput) =>
  call<ReservationPackageView>(`/v1/reservations/packages/${id}`, { method: 'PUT', body: JSON.stringify(dto) });
export const setPackageActive = (id: string, active: boolean) =>
  call<ReservationPackageView>(`/v1/reservations/packages/${id}`, { method: 'PATCH', body: JSON.stringify({ active }) });

export const fetchNight = (night: string) => call<ReservationView[]>(`/v1/reservations?night=${encodeURIComponent(night)}`);
export const fetchOverdue = () => call<ReservationView[]>('/v1/reservations/overdue');
export const bookFromPanel = (dto: CreateReservationDto) => call<{ reservation: ReservationView; link: string }>('/v1/reservations', post(dto));
export const setTable = (id: string, tableLabel: string | null) =>
  call<ReservationView>(`/v1/reservations/${id}/table`, { method: 'PATCH', body: JSON.stringify({ tableLabel }) });
export const venueChangeDate = (id: string, nightDate: string) => call<ReservationView>(`/v1/reservations/${id}/date`, post({ nightDate }));
/** El local anula: lo pagado (saldoCents) queda como saldo del cliente; nada se devuelve. */
export const venueCancel = (id: string, reason: string) =>
  call<{ reservation: ReservationView; saldoCents: number; walletId: string | null }>(`/v1/reservations/${id}/cancel`, post({ reason }));
export const markNoShow = (id: string) => call<ReservationView>(`/v1/reservations/${id}/no-show`, post({}));
export const undoNoShow = (id: string) => call<ReservationView>(`/v1/reservations/${id}/no-show/undo`, post({}));
/** «Ha venido»: el encargado apunta la llegada (también la de una noche pasada). */
export const arriveFromPanel = (id: string) => call<ReservationView>(`/v1/reservations/${id}/arrive`, post({}));
export const setOpenTime = (openTime: string) =>
  call<ReservationSettings>('/v1/reservations/settings', { method: 'PATCH', body: JSON.stringify({ openTime }) });

export const fetchReservationSettings = () => call<ReservationSettings>('/v1/reservations/settings');
export const setReservationsEnabled = (enabled: boolean) =>
  call<ReservationSettings>('/v1/reservations/settings', { method: 'PATCH', body: JSON.stringify({ enabled }) });
export const fetchAccounting = (from: string, to: string) =>
  call<ReservationAccounting & { toSaldoCents: number }>(`/v1/reservations/accounting?from=${from}&to=${to}`);

export const fetchPromoters = () => call<PromoterView[]>('/v1/reservations/promoters');
export const createPromoter = (userId: string, commissionBps: number) => call<PromoterView>('/v1/reservations/promoters', post({ userId, commissionBps }));
export const updatePromoter = (id: string, patch: { commissionBps?: number; active?: boolean }) =>
  call<PromoterView>(`/v1/reservations/promoters/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
