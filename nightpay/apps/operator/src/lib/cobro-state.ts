// En qué está un cobro único mientras se espera (maqueta 3.1–3.4): lo que
// dicen la tarjeta (el QR) y el saldo (el NFC, su PIN o su Face ID), y un
// fallo del NFC en este móvil. Gana el primero que se paga: el servidor
// cancela el otro. Función pura (se prueba sin pantalla).

import type { PaymentStatus } from '@nightpay/contracts';
import type { SaldoState } from './api-cobro';
import type { FailReason, PaidMethod } from './cobro-view';

export type CobroOutcome =
  | { kind: 'waiting' }
  /** `tipCents` null: pagado con tarjeta y su propina aún no se sabe (solo llegó el estado). */
  | { kind: 'paid'; method: PaidMethod; newBalanceCents: number | null; tipCents: number | null }
  /** `qrStillOpen`: el mismo cobro sigue vivo («Cobrar N € con QR» vuelve a él). */
  | { kind: 'failed'; reason: FailReason; qrStillOpen: boolean }
  | { kind: 'expired' }
  | { kind: 'canceled' };

const PAID: ReadonlySet<string> = new Set(['AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED']);

export interface CobroSignals {
  /** El cobro con tarjeta (null: el local cobra solo con saldo). */
  card: { status: PaymentStatus; tipCents?: number } | null;
  /** El cobro del saldo (null: el local no cobra con saldo). */
  saldo: Pick<SaldoState, 'status' | 'paidWith' | 'newBalanceCents' | 'tipCents'> | null;
  /** El NFC acercado aquí no pagó (saldo insuficiente, bloqueado…). */
  localFail: FailReason | null;
  /** Lo canceló quien cobra («Cancelar»). */
  canceledByMe: boolean;
}

export function cobroOutcome({ card, saldo, localFail, canceledByMe }: CobroSignals): CobroOutcome {
  if (saldo?.status === 'ACCEPTED') {
    return { kind: 'paid', method: saldo.paidWith ?? 'nfc_nopin', newBalanceCents: saldo.newBalanceCents ?? null, tipCents: saldo.tipCents ?? 0 };
  }
  if (card && PAID.has(card.status)) return { kind: 'paid', method: 'card', newBalanceCents: null, tipCents: card.tipCents ?? null };
  if (canceledByMe) return { kind: 'canceled' };
  const cardOpen = card !== null && !['FAILED', 'EXPIRED', 'CANCELED'].includes(card.status);
  const saldoOpen = saldo?.status === 'PENDING';
  if (localFail) return { kind: 'failed', reason: localFail, qrStillOpen: cardOpen || saldoOpen };
  if (card?.status === 'FAILED') {
    return {
      kind: 'failed',
      reason: { title: 'Tarjeta rechazada', sentence: 'El banco no ha aceptado la tarjeta.' },
      qrStillOpen: false,
    };
  }
  if (card?.status === 'EXPIRED' || (!card && saldo?.status === 'EXPIRED')) return { kind: 'expired' };
  // Tarjeta cancelada con el saldo aún pendiente aquí: lo acaba de pagar el
  // saldo (el servidor cancela la tarjeta entonces); la próxima consulta lo dice.
  if (card?.status === 'CANCELED' && saldoOpen) return { kind: 'waiting' };
  if (card?.status === 'CANCELED' || (!card && (saldo?.status === 'CANCELED' || saldo?.status === 'REJECTED'))) {
    return { kind: 'canceled' };
  }
  return { kind: 'waiting' };
}
