// En qué está un cobro único mientras se espera (maqueta 3.1–3.4): lo que
// dicen la tarjeta (el QR) y el saldo (el NFC, su PIN o su Face ID), y un
// fallo del NFC en este móvil. Gana el primero que se paga: el servidor
// cancela el otro. Función pura (se prueba sin pantalla).

import { bankWaitPhase, type BitcoinPayState, type PaymentStatus } from '@nightpay/contracts';
import type { SaldoState } from './api-cobro';
import type { FailReason, PaidMethod } from './cobro-view';
import { advanceStatus, type BitcoinLive } from './payment-status';

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

// ─── El cliente paga con bitcoin (BTCPay) ─────────────────────────────

/**
 * Con bitcoin no hay banco de por medio: el cobro pasa a AUTHORIZING al abrir
 * la factura, pero mientras espera el pago se puede cancelar (el API la cierra).
 * Con el pago ya en la red, no (llegaría igual); con un problema (pago a medias
 * o fuera de plazo), lo mira el encargado. En los dos, quien cobra puede salir
 * de la pantalla sin cancelar (el cobro sigue su curso y sale en «Cobros»).
 */
export const BITCOIN_CONFIRMING_TEXT = 'El cliente ya ha pagado con bitcoin: falta que la red lo confirme. Ya no se puede cancelar.';
export const BITCOIN_PROBLEM_TEXT = 'Hay un problema con el pago en bitcoin: avisa al encargado. No cobres otra vez.';
/** Salir de la pantalla sin cancelar ni cobrar otra vez (como con el banco sin confirmar). */
export const LEAVE_WITHOUT_CHARGING = 'Salir sin cobrar otra vez';

/** El código del 409 del API al cancelar con el pago en bitcoin ya en la red. */
export const BITCOIN_CONFIRMING_CODE = 'BITCOIN_CONFIRMING';

/** El cobro con tarjeta (el QR) en la pantalla: su estado y, pagando con bitcoin, el de su factura. */
export interface CardLive {
  status: PaymentStatus;
  /** null: no paga con bitcoin (o aún no lo dijo el sondeo); 'unknown': el API no lo dice. */
  bitcoin: BitcoinLive | null;
}

/**
 * Lo que dicen el tiempo real y el sondeo. El estado nunca va hacia atrás
 * (advanceStatus), salvo con bitcoin: la factura se cerró sin pagarse (caducó o
 * el cliente eligió pagar de otra forma) y el cobro vuelve a estar abierto. Se
 * sabe por lo que dijo antes el sondeo (pagaba con bitcoin) o porque lo dice
 * ahora ('closed'). La factura solo la dice el sondeo; fuera de AUTHORIZING deja de contar.
 */
export function cardAfter(card: CardLive, update: { status: PaymentStatus; bitcoin?: BitcoinLive | null }): CardLive {
  const wasBitcoin = card.bitcoin !== null || update.bitcoin === 'closed';
  const reopened = wasBitcoin && card.status === 'AUTHORIZING' && update.status === 'AWAITING_CAPTURE';
  const status = reopened ? update.status : advanceStatus(card.status, update.status);
  // Sin dato nuevo se mantiene lo que había mientras siga pagando; un pago nuevo tras cerrarse la factura, aún no se sabe.
  const kept = status === 'AUTHORIZING' && card.bitcoin !== 'closed' ? card.bitcoin : null;
  const bitcoin = update.bitcoin !== undefined ? update.bitcoin : kept;
  return status === card.status && bitcoin === card.bitcoin ? card : { status, bitcoin };
}

/** Paga con bitcoin ahora mismo (AUTHORIZING con su factura): sin las fases ni el reloj del banco. */
export function payingWithBitcoin(card: CardLive): Exclude<BitcoinPayState, 'closed'> | null {
  const b = card.bitcoin;
  return card.status === 'AUTHORIZING' && b !== null && b !== 'closed' && b !== 'unknown' ? b : null;
}

/**
 * El pie de Esperando: el botón «Cancelar cobro», o por qué no se puede (y,
 * con bitcoin en la red o con un problema, salir sin cancelar: si no, la
 * pantalla se quedaría ahí hasta que se confirme o lo resuelva el encargado).
 */
export type CancelOffer = { kind: 'button' } | { kind: 'text'; text: string } | { kind: 'leave'; text: string };

export function cancelOffer(card: CardLive): CancelOffer {
  // Sin saber si paga con bitcoin (el API no lo dice): el botón, y decide el servidor (con el banco, no deja).
  if (card.status !== 'AUTHORIZING' || card.bitcoin === 'open' || card.bitcoin === 'unknown') return { kind: 'button' };
  if (card.bitcoin === 'confirming') return { kind: 'leave', text: BITCOIN_CONFIRMING_TEXT };
  if (card.bitcoin === 'problem') return { kind: 'leave', text: BITCOIN_PROBLEM_TEXT };
  return { kind: 'text', text: CANCEL_WHILE_PAYING_TEXT };
}

/** El aviso cuando «Cancelar cobro» falla: sin hablar del banco si paga con bitcoin. */
export function cancelFailedText(card: CardLive, code: string | null): string {
  if (code === BITCOIN_CONFIRMING_CODE || (card.status === 'AUTHORIZING' && card.bitcoin === 'confirming')) return BITCOIN_CONFIRMING_TEXT;
  if (card.status === 'AUTHORIZING' && card.bitcoin === 'unknown') {
    return 'No se ha podido cancelar: el cliente está pagando (en su banco o con bitcoin). Espera y mira si ya está pagado.';
  }
  if (card.status === 'AUTHORIZING' && card.bitcoin) return 'No se ha podido cancelar: puede que el cliente acabe de pagar con bitcoin. Mira si ya está pagado.';
  if (card.status === 'AUTHORIZING') return 'No se puede cancelar mientras el cliente paga en su banco: espera su respuesta.';
  return 'No se ha podido cancelar: mira si ya está pagado.';
}

/** La pastilla viva mientras paga con bitcoin (en vez de las fases del banco, que no aplican). */
export function bitcoinWaitText(bitcoin: Exclude<BitcoinPayState, 'closed'>): string {
  if (bitcoin === 'confirming') return 'Pagado con bitcoin · falta 1 confirmación de la red';
  if (bitcoin === 'problem') return 'Problema con el pago en bitcoin';
  return 'El cliente está pagando con bitcoin…';
}

/** La pantalla ámbar del cobro que el banco no confirmó (ORPHAN). */
export const UNCONFIRMED_TITLE = 'El banco no lo ha confirmado';
export const UNCONFIRMED_SENTENCE =
  'Puede que se haya cobrado. No cobres otra vez: avisa al encargado para que lo mire en el banco. Si el banco lo confirma, aquí sale PAGADO.';
