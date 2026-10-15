// Importes del panel: un solo formato (español, con €) en todas las pestañas.

const EUR = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });

/** Céntimos → "12,50 €" / "12.345,67 €" / "-3,00 €". */
export function formatEur(cents: number): string {
  return EUR.format(cents / 100);
}

/**
 * Importe de un cobro en su moneda (los cobros guardan la suya). Una moneda
 * que Intl no conoce se enseña tal cual, sin romper la tabla.
 */
export function formatMoney(cents: number, currency: string): string {
  if (currency === 'EUR') return formatEur(cents);
  try {
    return new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${formatDecimal(cents / 100, 2)} ${currency}`;
  }
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
