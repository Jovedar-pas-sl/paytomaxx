import { createHash } from 'node:crypto';

/**
 * Idempotency-Key de POST /payments. La clave sola no basta: con la misma
 * clave, otra persona del local recibía el cobro de otra (con su QR) y una
 * petición distinta recibía en silencio el cobro antiguo. Por eso se guarda,
 * junto a la clave, la huella de quién crea el cobro y de lo que pide.
 */

/** Huella de la petición: quién la hace y lo que pide (sin depender del orden de las claves). */
export function idempotencyHashOf(creatorUserId: string | null, body: unknown): string {
  return createHash('sha256')
    .update(stableJson({ v: 1, creator: creatorUserId, body }))
    .digest('hex');
}

/**
 * ¿La petición repetida es la misma que creó el cobro? Los cobros de antes de
 * guardar la huella solo se pueden comparar por quién los creó.
 */
export function sameIdempotentRequest(
  existing: { idempotencyHash: string | null; createdByUserId: string | null },
  hash: string,
  creatorUserId: string | null,
): boolean {
  if (existing.idempotencyHash !== null) return existing.idempotencyHash === hash;
  return existing.createdByUserId === creatorUserId;
}

/** JSON con las claves ordenadas y sin `undefined` (dos cuerpos iguales → mismo texto). */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, sortKeys(v)]),
  );
}
