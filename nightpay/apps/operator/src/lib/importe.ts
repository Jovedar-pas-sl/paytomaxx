// «Otro importe» (maqueta 1.3): se teclea en euros, como se dice («35», «12,50»),
// con coma para los céntimos. Lo tecleado es un texto («35,5»); el importe,
// en céntimos. Funciones puras.

export type ImporteKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | ',' | 'back';

/** El teclado: 1-9, coma, 0 y borrar (siempre en este orden). */
export const IMPORTE_KEYS: readonly ImporteKey[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', ',', '0', 'back'];

/** Como mucho, lo de un cobro tecleado (10.000 €). */
export const MAX_IMPORTE_CENTS = 10_000_00;

/** Lo tecleado tras pulsar una tecla (sin pasar del tope, dos decimales, sin ceros delante). */
export function pressImporte(typed: string, key: ImporteKey, maxCents: number = MAX_IMPORTE_CENTS): string {
  if (key === 'back') return typed.slice(0, -1);
  if (key === ',') {
    if (typed.includes(',')) return typed;
    return typed === '' ? '0,' : `${typed},`;
  }
  const [, decimals] = typed.split(',');
  if (decimals !== undefined && decimals.length >= 2) return typed;
  const next = typed === '0' ? key : `${typed}${key}`;
  return importeCents(next) > maxCents ? typed : next;
}

/** «35» → 3500; «12,5» → 1250; «0,» → 0. */
export function importeCents(typed: string): number {
  if (!typed) return 0;
  const [whole = '', decimals = ''] = typed.split(',');
  const euros = Number.parseInt(whole || '0', 10);
  const cents = Number.parseInt((decimals + '00').slice(0, 2), 10);
  return (Number.isFinite(euros) ? euros : 0) * 100 + (Number.isFinite(cents) ? cents : 0);
}

/** Lo que se ve: «35», «12,5», «0» si no hay nada. */
export function importeShown(typed: string): string {
  return typed === '' ? '0' : typed;
}
