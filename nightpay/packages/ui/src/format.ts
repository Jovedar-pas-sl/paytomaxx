// Importes en español de España (coma decimal, punto de miles): 1234,50 €.
// Los importes viajan en céntimos enteros.

const EUR = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });

/** 4850 → "48,50 €". */
export function formatEur(cents: number): string {
  return EUR.format(cents / 100);
}

/** Trozos de un importe para pintarlos con tamaños distintos (AmountDisplay). */
export interface AmountParts {
  /** Parte entera, con signo y separador de miles: "12.345". */
  readonly whole: string;
  /** Separador decimal (","); vacío si la moneda no lleva decimales. */
  readonly decimal: string;
  readonly fraction: string;
  /** Código de la moneda: "EUR". */
  readonly code: string;
  /** El importe entero para lectores de pantalla: "48,50 €". */
  readonly text: string;
}

function currencyFormat(currency: string, display: 'code' | 'symbol'): Intl.NumberFormat | null {
  try {
    return new Intl.NumberFormat('es-ES', { style: 'currency', currency, currencyDisplay: display });
  } catch {
    // Código de moneda que Intl no conoce: se formatea como número normal.
    return null;
  }
}

export function amountParts(cents: number, currency: string): AmountParts {
  const value = cents / 100;
  const coded = currencyFormat(currency, 'code');
  if (!coded) {
    const plain = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return partsOf(plain.formatToParts(value), currency, `${plain.format(value)} ${currency}`);
  }
  const text = currencyFormat(currency, 'symbol')?.format(value) ?? coded.format(value);
  return partsOf(coded.formatToParts(value), currency, text);
}

function partsOf(parts: Intl.NumberFormatPart[], currency: string, text: string): AmountParts {
  const join = (...types: string[]) =>
    parts
      .filter((p) => types.includes(p.type))
      .map((p) => p.value)
      .join('');
  return {
    whole: join('minusSign', 'integer', 'group'),
    decimal: join('decimal'),
    fraction: join('fraction'),
    code: join('currency') || currency,
    text,
  };
}
