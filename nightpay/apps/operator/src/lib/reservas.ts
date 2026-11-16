// Reservados: qué toca en la puerta y en la barra con una reserva leída (reservas.test.ts).

import type { ReservationView } from '@nightpay/contracts';

export type DoorStep =
  /** Falta el 70 %: cobrarlo con tarjeta antes de dejar pasar. */
  | { kind: 'pay-rest'; pendingCents: number }
  /** Pagado entero: «Dar la llegada». */
  | { kind: 'arrive' }
  /** Ya han llegado: solo apuntar que entra esta persona. */
  | { kind: 'arrived' }
  /** No se puede (sin pagar, anulada, «No vino» u otra noche). */
  | { kind: 'blocked'; reason: string };

export function doorStep(r: Pick<ReservationView, 'status' | 'pendingCents' | 'nightDate'>, tonight: string): DoorStep {
  if (r.status === 'ARRIVED') return { kind: 'arrived' };
  if (r.status === 'CANCELED') return { kind: 'blocked', reason: 'Reserva anulada' };
  if (r.status === 'NO_SHOW') return { kind: 'blocked', reason: 'Marcada como «No vino»: el encargado lo puede deshacer' };
  if (r.status === 'CLIENT_CANCELED') return { kind: 'blocked', reason: 'Anulada por el cliente' };
  if (r.status === 'PENDING') return { kind: 'blocked', reason: 'Sin pagar: no tiene la señal' };
  if (r.nightDate !== tonight) return { kind: 'blocked', reason: `Es de otra noche (${r.nightDate})` };
  if (r.pendingCents > 0) return { kind: 'pay-rest', pendingCents: r.pendingCents };
  return { kind: 'arrive' };
}

export type BarMode =
  | { kind: 'credit'; balanceCents: number }
  | { kind: 'items'; items: ReservationView['itemsLeft'] }
  | { kind: 'closed'; reason: string };

/** En la barra: cobrar un importe (paquete de importe) o servir cosas (paquete de cosas fijas). */
export function barMode(r: Pick<ReservationView, 'status' | 'kind' | 'balanceCents' | 'itemsLeft'>): BarMode {
  if (r.status !== 'ARRIVED') return { kind: 'closed', reason: 'Primero, la llegada en la puerta' };
  if (r.kind === 'CREDIT') return { kind: 'credit', balanceCents: r.balanceCents ?? 0 };
  return { kind: 'items', items: r.itemsLeft };
}

/** «12», «12,50» → céntimos (null si no es un importe válido o es 0). */
export function amountCents(text: string): number | null {
  const t = text.trim().replace(',', '.');
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(t)) return null;
  const cents = Math.round(Number(t) * 100);
  return cents > 0 ? cents : null;
}

/** La noche de ahora en Madrid: antes de las 08:00 aún es la de ayer. */
export function tonightInMadrid(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() - 8 * 3600_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(shifted);
}

/** Una clave para no cobrar dos veces lo mismo (doble toque, la red). */
export function newSpendKey(): string {
  return `rs:${Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
