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

// ─── Importes en pantalla ──────────────────────────────────────────────

export interface MoneyFormatOptions {
  /** «33 €» en vez de «33,00 €» cuando no hay céntimos (lo que ve el cliente y el personal). */
  compact?: boolean;
  /** es-ES de fábrica; las páginas del cliente en inglés, en-GB. */
  locale?: string;
  currency?: string;
}

/** Signo menos de verdad (U+2212): se alinea con las cifras; el guion no. */
export const MINUS_SIGN = '−';

const MONEY_FORMATS = new Map<string, Intl.NumberFormat | null>();

function moneyFormat(locale: string, currency: string, digits: number): Intl.NumberFormat | null {
  const key = `${locale}|${currency}|${digits}`;
  if (!MONEY_FORMATS.has(key)) {
    try {
      MONEY_FORMATS.set(
        key,
        new Intl.NumberFormat(locale, {
          style: 'currency',
          currency,
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
          // Miles siempre con punto: es-ES no agrupa 4 cifras por defecto («1109 €»).
          // Un navegador antiguo lo lee como `true` (agrupa como siempre).
          useGrouping: 'always' as unknown as boolean,
        }),
      );
    } catch {
      MONEY_FORMATS.set(key, null);
    }
  }
  return MONEY_FORMATS.get(key) ?? null;
}

/**
 * Un importe para la pantalla, igual en todas partes: «1.109,50 €», con
 * `compact` «33 €» (sin «,00» si no hay céntimos), y «−12 €» con el signo
 * menos de verdad. Los importes viajan en céntimos. Una moneda que Intl no
 * conoce sale como cifra y código («12,00 XYZ»).
 */
export function formatMoney(cents: number, { compact = false, locale = 'es-ES', currency = 'EUR' }: MoneyFormatOptions = {}): string {
  const digits = compact && cents % 100 === 0 ? 0 : 2;
  const fmt = moneyFormat(locale, currency, digits);
  const text = fmt
    ? fmt.format(cents / 100)
    : `${(cents / 100).toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${currency}`;
  return text.replace('-', MINUS_SIGN);
}
