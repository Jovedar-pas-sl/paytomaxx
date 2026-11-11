// En qué está un cobro único mientras se espera (maqueta 3.1–3.4): lo que
// dicen la tarjeta (el QR) y el saldo (el NFC, su PIN o su Face ID), y un
// fallo del NFC en este móvil. Gana el primero que se paga: el servidor
// cancela el otro. Función pura (se prueba sin pantalla).

import { bankWaitPhase, type PaymentStatus } from '@nightpay/contracts';
import type { SaldoState } from './api-cobro';
import type { FailReason, PaidMethod } from './cobro-view';

export type CobroOutcome =
  | { kind: 'waiting' }
  /**
   * La tarjeta se quedó sin respuesta del banco (ORPHAN): pudo cobrarse. Ni
   * «Otro QR» ni volver a la espera: se avisa al encargado y, si el banco lo
   * aprueba luego, PAGADO.
   */
  | { kind: 'unconfirmed' }
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
  if (card?.status === 'ORPHAN') return { kind: 'unconfirmed' };
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

// ─── El cliente paga con tarjeta: la espera del banco (05-ui-ux §4.3) ─────

/**
 * Lo que ve el camarero mientras el cliente paga en la página de su banco,
 * desde que salió el intento (AUTHORIZING), con los tiempos del cliente
 * (@nightpay/contracts/pay-wait): `scan` (aún no ha ido al banco: lo de
 * siempre), `paying` (0–20 s), `slow` (20–60 s, franja ámbar), `still`
 * (60–150 s) y `retry` (pasados 2:30 con el QR vigente: el cliente puede
 * volver a intentarlo).
 */
export type CardWaitStage = 'scan' | 'paying' | 'slow' | 'still' | 'retry';

export interface CardWait {
  stage: CardWaitStage;
  /** Desde que el intento salió al banco (0 si aún no). */
  elapsedMs: number;
}

const STAGE_OF = { confirming: 'paying', slow: 'slow', still: 'still', retry: 'retry' } as const;

export function cardWait(input: {
  status: PaymentStatus | null;
  /** Cuándo salió el intento (el del servidor; si no lo dice, cuándo se vio AUTHORIZING aquí). */
  attemptStartedAtMs: number | null;
  qrExpiresAtMs: number | null;
  nowMs: number;
}): CardWait {
  if (input.status !== 'AUTHORIZING' || input.attemptStartedAtMs === null) return { stage: 'scan', elapsedMs: 0 };
  const elapsedMs = Math.max(0, input.nowMs - input.attemptStartedAtMs);
  // Volver a intentarlo solo con el QR aún vigente (sin saberlo, no se dice).
  const qrOpen = input.qrExpiresAtMs !== null && input.qrExpiresAtMs > input.nowMs;
  return { stage: STAGE_OF[bankWaitPhase(elapsedMs, qrOpen)], elapsedMs };
}

/** «0:05», «1:12». */
function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * La pastilla viva en cada fase: la frase (cambia solo al cambiar de fase: es
 * lo que lee el lector de pantalla) y el reloj aparte (cada segundo, oculto
 * al lector). null: la de siempre, «Esperando el pago…».
 */
export function cardWaitParts(w: CardWait): { label: string; clock: string | null } | null {
  switch (w.stage) {
    case 'paying':
      return { label: 'El cliente está pagando…', clock: clock(w.elapsedMs) };
    case 'slow':
      return { label: 'El banco está tardando · No cobres otra vez', clock: null };
    case 'still':
      return { label: 'Sigue esperando al banco ·', clock: clock(w.elapsedMs) };
    case 'retry':
      return { label: 'El cliente puede volver a intentarlo', clock: null };
    default:
      return null;
  }
}

/** La pastilla entera, como se lee en la pantalla. */
export function cardWaitText(w: CardWait): string | null {
  const parts = cardWaitParts(w);
  return parts ? [parts.label, parts.clock].filter(Boolean).join(' ') : null;
}

/** Desde los 20 s la franja ámbar: lo importante es que no se cobre otra vez. */
export function showsBankStrip(w: CardWait): boolean {
  return w.stage === 'slow' || w.stage === 'still' || w.stage === 'retry';
}

/**
 * Una hora del servidor en el reloj de este móvil, con un ancla conocida en
 * los dos (el plazo del QR: el del servidor y su cuenta atrás aquí). Así un
 * móvil con la hora mal puesta cuenta bien la espera.
 */
export function serverToLocalMs(serverMs: number, anchor: { serverMs: number; localMs: number } | null): number {
  return anchor ? serverMs - (anchor.serverMs - anchor.localMs) : serverMs;
}

/** Con el cliente pagando en su banco no se puede cancelar (el API no lo deja): se dice y se espera. */
export const CANCEL_WHILE_PAYING_TEXT = 'El cliente está pagando en su banco: espera su respuesta. Hasta entonces no se puede cancelar.';

/** La pantalla ámbar del cobro que el banco no confirmó (ORPHAN). */
export const UNCONFIRMED_TITLE = 'El banco no lo ha confirmado';
export const UNCONFIRMED_SENTENCE =
  'Puede que se haya cobrado. No cobres otra vez: avisa al encargado para que lo mire en el banco. Si el banco lo confirma, aquí sale PAGADO.';
