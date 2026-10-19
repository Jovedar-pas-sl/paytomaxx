import type { PaymentStatus } from '../components/StatusPill';

/**
 * Orden de los estados de un cobro: la máquina del API solo avanza
 * (CREATED → AWAITING_CAPTURE → AUTHORIZING → final; ORPHAN se resuelve en
 * AUTHORIZED o FAILED). Así una respuesta que llega tarde (un sondeo lento
 * tras el evento del socket) no hace retroceder la pantalla.
 */
const RANK: Record<PaymentStatus, number> = {
  CREATED: 0,
  AWAITING_CAPTURE: 1,
  AUTHORIZING: 2,
  ORPHAN: 3,
  AUTHORIZED: 4,
  FAILED: 4,
  EXPIRED: 4,
  CANCELED: 4,
  PARTIALLY_REFUNDED: 5,
  REFUNDED: 6,
};

/** El estado con el que se queda la pantalla: nunca va hacia atrás. */
export function advanceStatus(current: PaymentStatus | null, next: PaymentStatus): PaymentStatus {
  if (current === null) return next;
  return RANK[next] >= RANK[current] ? next : current;
}

/** Pagado, fallido, caducado o cancelado: ya no cambia mientras se mira. */
export function isFinalStatus(status: PaymentStatus): boolean {
  return RANK[status] >= RANK.AUTHORIZED;
}
