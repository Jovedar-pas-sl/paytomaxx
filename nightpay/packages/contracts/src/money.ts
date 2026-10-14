/** Tope de un importe tecleado a mano (100.000 €). */
export const MAX_TYPED_AMOUNT_CENTS = 10_000_000;

/**
 * Importe tecleado → céntimos, sin decimales de coma flotante.
 *   "50" → 5000 · "50,5" → 5050 · "50.50" → 5050 · "1.234,56" → 123456 · "75 €" → 7500
 * Lo que no es un importe ("12abc", "1,5,3", "1,234.5", "", "0") → null.
 */
export function parseEuroCents(input: string, maxCents: number = MAX_TYPED_AMOUNT_CENTS): number | null {
  const s = input.trim().replace(/[\s€]/g, '');
  if (!s) return null;
  let whole: string;
  let decimals: string;
  const plain = /^(\d{1,7})(?:[.,](\d{1,2}))?$/.exec(s);
  if (plain) {
    whole = plain[1]!;
    decimals = plain[2] ?? '';
  } else {
    // Miles con punto y decimales con coma: "1.234,56".
    const grouped = /^(\d{1,3}(?:\.\d{3})+)(?:,(\d{1,2}))?$/.exec(s);
    if (!grouped) return null;
    whole = grouped[1]!.replace(/\./g, '');
    decimals = grouped[2] ?? '';
  }
  const cents = Number(whole) * 100 + Number(decimals.padEnd(2, '0'));
  return cents > 0 && cents <= maxCents ? cents : null;
}
