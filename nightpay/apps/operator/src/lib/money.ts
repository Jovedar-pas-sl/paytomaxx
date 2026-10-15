/**
 * Importes en euros, iguales en toda la app: coma decimal y "€" detrás
 * ("60,50 €"), como se escriben en España. Los importes llegan en céntimos.
 */
const EUR = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
const EUR_WHOLE = new Intl.NumberFormat('es-ES', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const AMOUNT = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export interface EurOptions {
  /** "60 €" en vez de "60,00 €" cuando no hay céntimos (la carta, el saldo). */
  compact?: boolean;
}

export function formatEur(cents: number, { compact = false }: EurOptions = {}): string {
  const format = compact && cents % 100 === 0 ? EUR_WHOLE : EUR;
  return format.format(cents / 100);
}

/** Con su signo delante ("+1,20 €" / "−1,20 €"): comisiones y devoluciones. */
export function formatSignedEur(cents: number, options?: EurOptions): string {
  if (cents === 0) return formatEur(0, options);
  return `${cents < 0 ? '−' : '+'}${formatEur(Math.abs(cents), options)}`;
}

/** Solo la cifra ("123,45"), para cuando el "EUR" va aparte con otro estilo. */
export function formatEurAmount(cents: number): string {
  return AMOUNT.format(cents / 100);
}

const PERCENT = new Intl.NumberFormat('es-ES', { style: 'percent', maximumFractionDigits: 2 });

/** Comisión en puntos básicos (3750 = 37,5 %), sin redondear a entero. */
export function formatBps(bps: number): string {
  return PERCENT.format(bps / 10_000);
}
