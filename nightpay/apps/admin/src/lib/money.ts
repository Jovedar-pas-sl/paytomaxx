// Importes del panel: el formato de toda la app (formatMoney de
// @nightpay/contracts): con céntimos, el punto de los miles siempre
// («1.329,00 €») y el signo menos de verdad («−3,00 €»). Las tablas siguen
// alineadas (cifras tabulares) y ningún céntimo se pierde.
import { formatMoney as moneyText } from '@nightpay/contracts';

/** Céntimos → "12,50 €" / "1.234,56 €" / "−3,00 €". */
export function formatEur(cents: number): string {
  return moneyText(cents);
}

/**
 * Importe de un cobro en su moneda (los cobros guardan la suya). Una moneda
 * que Intl no conoce se enseña tal cual, sin romper la tabla.
 */
export function formatMoney(cents: number, currency: string): string {
  return moneyText(cents, { currency });
}

/** Número con decimales fijos en formato español: 1.07 → "1,07". */
export function formatDecimal(value: number, fractionDigits: number): string {
  return value.toLocaleString('es-ES', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

/** Céntimos → texto para un campo de importe editable ("12,50"); lo lee parseEuroCents. */
export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',');
}
