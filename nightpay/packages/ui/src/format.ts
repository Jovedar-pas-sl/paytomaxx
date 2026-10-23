// Importes en español de España: el formato de toda la app (formatMoney de
// @nightpay/contracts): coma decimal, el punto de los miles siempre
// («1.234,50 €») y el signo menos de verdad («−3,00 €»). Los importes viajan
// en céntimos enteros.

import { formatMoney, MINUS_SIGN } from '@nightpay/contracts';

/** 4850 → "48,50 €"; 123450 → "1.234,50 €". */
export function formatEur(cents: number): string {
  return formatMoney(cents);
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

// useGrouping «always» (ES2023): «1.234» y no «1234», como formatMoney. Los tipos de TS aún no lo traen.
const ALWAYS = { useGrouping: 'always' } as unknown as Intl.NumberFormatOptions;

function codedFormat(currency: string): Intl.NumberFormat | null {
  try {
    return new Intl.NumberFormat('es-ES', { style: 'currency', currency, currencyDisplay: 'code', ...ALWAYS });
  } catch {
    // Código de moneda que Intl no conoce: se formatea como número normal.
    return null;
  }
}

export function amountParts(cents: number, currency: string): AmountParts {
  const value = cents / 100;
  const coded = codedFormat(currency);
  const text = formatMoney(cents, { currency });
  if (!coded) {
    const plain = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2, ...ALWAYS });
    return partsOf(plain.formatToParts(value), currency, text);
  }
  return partsOf(coded.formatToParts(value), currency, text);
}

function partsOf(parts: Intl.NumberFormatPart[], currency: string, text: string): AmountParts {
  const join = (...types: string[]) =>
    parts
      .filter((p) => types.includes(p.type))
      .map((p) => (p.type === 'minusSign' ? MINUS_SIGN : p.value))
      .join('');
  return {
    whole: join('minusSign', 'integer', 'group'),
    decimal: join('decimal'),
    fraction: join('fraction'),
    code: join('currency') || currency,
    text,
  };
}
