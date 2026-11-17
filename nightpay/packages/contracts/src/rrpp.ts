import type { ReservationStatus } from './reservations';

/**
 * «Tus reservas de RRPP» en la app del personal (GET /v1/staff/me/promoter):
 * solo lo de quien ha entrado, en su local. Nunca datos del cliente (ni
 * nombre, ni teléfono, ni notas) ni lo de otros RRPP.
 */

/** Su comisión de una reserva: ganada, cuando la paguen entera, o ninguna (sin pagar entera o el local se la quitó). */
export type MyPromoterCommission = 'EARNED' | 'EXPECTED' | 'NONE';

export interface MyPromoterReservation {
  ref: string;
  /** La noche, "AAAA-MM-DD". */
  nightDate: string;
  packageName: string;
  /** Personas (entradas) del paquete. */
  entries: number;
  status: ReservationStatus;
  statusText: string;
  priceCents: number;
  paidCents: number;
  /** Lo que falta por pagar (0 si ya no se puede pagar: llegada, «No vino» o anulada). */
  pendingCents: number;
  /** Su comisión de esta reserva, con su % de cuando la vendió. */
  commissionCents: number;
  commission: MyPromoterCommission;
}

export interface MyPromoterView {
  /** Su enlace para reservar. */
  url: string;
  commissionBps: number;
  /** Su comisión de RRPP: ganada = por cobrar + cobrada (el pago, en «Pagos a compañeras»). */
  earnedCents: number;
  toPayCents: number;
  paidCents: number;
  /** Desde esta noche en adelante. */
  upcoming: MyPromoterReservation[];
  /** Las noches pasadas más recientes. */
  recent: MyPromoterReservation[];
}

/** promoter: null si quien entra no es RRPP de este local (o está de baja). */
export interface MyPromoterPage {
  promoter: MyPromoterView | null;
}
