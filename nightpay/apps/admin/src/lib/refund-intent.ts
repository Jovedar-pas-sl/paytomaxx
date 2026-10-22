// La clave de una devolución pedida desde el panel (Idempotency-Key).
//
// Una por cobro mientras no se sabe en qué quedó la devolución: si se corta
// la red, se cierra el modal o se recarga la pestaña, el siguiente «Devolver»
// de ese cobro lleva la MISMA clave y el API devuelve lo que pasó la primera
// vez en vez de devolver otra vez (con otro importe, 409: ya se pidió otra).
// En cuanto hay respuesta definitiva (hecha, pedida al dueño, rechazada…) se
// suelta: otra devolución parcial a propósito lleva otra clave.

import { ApiError } from './api-errors';

/** Pasado este rato sin respuesta, la siguiente es otra devolución (y se ve la lista). */
export const REFUND_INTENT_TTL_MS = 15 * 60_000;

/** Respuestas tras las que se puede pedir otra devolución con otra clave. */
const SETTLED_CODES: ReadonlySet<string> = new Set([
  'REFUND_REJECTED', // la pasarela no la hizo
  'REFUND_FAILED', // se marcó como no hecha
  'REFUND_KEY_REUSED', // la clave ya era de otra devolución
  'REFUND_APPROVAL_CLOSED', // el dueño la rechazó o caducó
]);

interface Intention {
  key: string;
  createdAt: number;
}

const memory = new Map<string, Intention>();
const storageKey = (paymentId: string) => `nightpay:refund-intent:${paymentId}`;

function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null; // Navegación privada o almacenamiento bloqueado: queda la de memoria.
  }
}

function readStored(paymentId: string): Intention | null {
  try {
    const raw = storage()?.getItem(storageKey(paymentId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const { key, createdAt } = parsed as Record<string, unknown>;
    return typeof key === 'string' && key.length >= 8 && typeof createdAt === 'number' ? { key, createdAt } : null;
  } catch {
    return null;
  }
}

function store(paymentId: string, intention: Intention | null): void {
  try {
    if (intention) storage()?.setItem(storageKey(paymentId), JSON.stringify(intention));
    else storage()?.removeItem(storageKey(paymentId));
  } catch {
    /* Sin almacenamiento: vale la de memoria. */
  }
}

/** La clave de la devolución de este cobro que aún no tiene respuesta (o una nueva). */
export function refundIntentKey(paymentId: string, now: number = Date.now()): string {
  const saved = memory.get(paymentId) ?? readStored(paymentId);
  if (saved && now - saved.createdAt < REFUND_INTENT_TTL_MS) {
    memory.set(paymentId, saved);
    return saved.key;
  }
  const fresh = { key: crypto.randomUUID(), createdAt: now };
  memory.set(paymentId, fresh);
  store(paymentId, fresh);
  return fresh.key;
}

/** La devolución de esta clave ya tiene respuesta: la siguiente del cobro es otra. */
export function settleRefundIntent(paymentId: string, key: string): void {
  const current = memory.get(paymentId) ?? readStored(paymentId);
  if (current && current.key !== key) return;
  memory.delete(paymentId);
  store(paymentId, null);
}

/** ¿Este error es definitivo para la clave? (si no, el siguiente intento la repite). */
export function settlesRefundIntent(err: unknown): boolean {
  return err instanceof ApiError && SETTLED_CODES.has(err.code ?? '');
}
