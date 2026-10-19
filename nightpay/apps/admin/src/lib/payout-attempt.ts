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

export type PayoutFailure =
  /** Lo pagable cambió (un cobro o una devolución entre medias): cerrar y mirar la cifra nueva. */
  | { kind: 'changed'; text: string }
  /** Sin respuesta o 5xx: puede que sí se apuntara. */
  | { kind: 'unknown'; text: string }
  /** No se apuntó: corregir y volver a probar. */
  | { kind: 'retry'; text: string };

export function payoutFailure(err: unknown): PayoutFailure {
  if (!(err instanceof ApiError)) return { kind: 'unknown', text: LOST_TEXT };
  if (err.code === PAYOUT_CHANGED_CODE) {
    return { kind: 'changed', text: `${err.message.replace(/\.?$/, '.')} Cierra y vuelve a abrirlo con la cifra nueva.` };
  }
  if (err.status === 0 || err.status >= 500) return { kind: 'unknown', text: LOST_TEXT };
  return { kind: 'retry', text: err.message };
}

/** UUID v4; fuera de HTTPS (sin randomUUID) 32 hex aleatorios. */
function newKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
