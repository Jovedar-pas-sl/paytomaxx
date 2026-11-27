// «Marcar pagado»: la clave del intento y qué hacer cuando falla. Lógica pura
// (probada en payout-attempt.test.ts).

import { ApiError } from './api-errors';

/** El API dice que lo pagable ya no es la cifra que vio el dueño (409). */
export const PAYOUT_CHANGED_CODE = 'PAYOUT_CHANGED';

/** La Idempotency-Key del pago y lo que se apunta con ella. */
export interface PayoutAttempt {
  readonly key: string;
  readonly what: string;
}

/** Lo que se apunta: a quién, la cifra que ve el dueño, por dónde y con qué referencia. */
export function payoutWhat(input: {
  operatorId: string;
  totalCents: number;
  rail: string;
  txId: string;
  receipt: string;
}): string {
  return [input.operatorId, input.totalCents, input.rail, input.txId, input.receipt].join('|');
}

/**
 * La misma clave si se repite lo mismo (sin respuesta, doble clic): el pago no
 * se apunta dos veces. Con otra cifra, otro método u otra referencia, otra clave.
 */
export function payoutAttempt(previous: PayoutAttempt | null, what: string): PayoutAttempt {
  return previous?.what === what ? previous : { key: newKey(), what };
}

const LOST_TEXT =
  'No sabemos si se apuntó el pago: el servidor no contestó. Mira sus liquidaciones antes de volver a probar.';

/** La clave de este intento ya se usó con otra petición (otras notas, otra chica…). */
export const KEY_REUSED_CODE = 'IDEMPOTENCY_KEY_REUSED';
export const KEY_REUSED_TEXT =
  'Este intento ya se usó con otros datos y no se ha apuntado ni pedido nada nuevo. Cierra y vuelve a abrirlo.';

export type PayoutFailure =
  /** Lo pagable cambió (un cobro o una devolución entre medias): cerrar y mirar la cifra nueva. */
  | { kind: 'changed'; text: string }
  /** Sin respuesta o 5xx: puede que sí se apuntara. */
  | { kind: 'unknown'; text: string }
  /** No se apuntó: corregir y volver a probar. */
  | { kind: 'retry'; text: string };

/** También al pedirlo al dueño («Por aprobar»): mismos códigos, mismo trato. */
export function payoutFailure(err: unknown): PayoutFailure {
  if (!(err instanceof ApiError)) return { kind: 'unknown', text: LOST_TEXT };
  if (err.code === PAYOUT_CHANGED_CODE) {
    return { kind: 'changed', text: `${err.message.replace(/\.?$/, '.')} Cierra y vuelve a abrirlo con la cifra nueva.` };
  }
  // Repetir con la misma clave no sirve (daría el mismo 409): se cierra y se abre otro intento.
  if (err.code === KEY_REUSED_CODE) return { kind: 'changed', text: KEY_REUSED_TEXT };
  if (err.status === 0 || err.status >= 500) return { kind: 'unknown', text: LOST_TEXT };
  return { kind: 'retry', text: err.message };
}

/**
 * UUID v4; fuera de HTTPS (sin randomUUID) 32 hex aleatorios. También la
 * clave de «Pagar a varias» (cabe en PAYOUT_BATCH_KEY_RE).
 */
export function newKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
