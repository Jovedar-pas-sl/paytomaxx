/**
 * Importes en euros, iguales en toda la app (formatMoney de
 * @nightpay/contracts): coma decimal y "€" detrás ("60,50 €"), el punto de los
 * miles siempre ("1.109 €") y el signo menos de verdad ("−60 €"). Los importes
 * llegan en céntimos.
 */
import { formatMoney } from '@nightpay/contracts';

export interface EurOptions {
  /** "60 €" en vez de "60,00 €" cuando no hay céntimos (la carta, el saldo). */
  compact?: boolean;
}

export function formatEur(cents: number, { compact = false }: EurOptions = {}): string {
  return formatMoney(cents, { compact });
}

/** Con su signo delante ("+1,20 €" / "−1,20 €"): comisiones y devoluciones. */
export function formatSignedEur(cents: number, options?: EurOptions): string {
  if (cents === 0) return formatEur(0, options);
  return `${cents < 0 ? '−' : '+'}${formatEur(Math.abs(cents), options)}`;
}

/** Comisión en puntos básicos (3750 = 37,5 %), sin redondear a entero: el de toda la app. */
export { formatBps } from '@nightpay/ui';
