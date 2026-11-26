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
  /** Solo la cifra («1.109,50»), para cuando la moneda va aparte con otro estilo. */
  bare?: boolean;
  /** Solo para gráficos: redondeado y corto («620 €», «3,1 mil €», «1,2 M €»). Nunca en un importe que se cobra o se paga. */
  short?: boolean;
}

/** Signo menos de verdad (U+2212): se alinea con las cifras; el guion no. */
export const MINUS_SIGN = '−';

const MONEY_FORMATS = new Map<string, Intl.NumberFormat | null>();

function moneyFormat(locale: string, currency: string, digits: number, bare: boolean): Intl.NumberFormat | null {
  const key = `${locale}|${currency}|${digits}|${bare ? 'n' : 'c'}`;
  if (!MONEY_FORMATS.has(key)) {
    try {
      MONEY_FORMATS.set(
        key,
        new Intl.NumberFormat(locale, {
          ...(bare ? { style: 'decimal' as const } : { style: 'currency' as const, currency }),
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
 * «1234,50» → «1.234,50»: pone los puntos a la parte entera cuando llega con 4
 * cifras o más seguidas. Un Chrome anterior al 106 (los datáfonos) lee
 * `useGrouping: 'always'` como «agrupa como siempre» y en español deja
 * «1234 €» sin punto. Lo ya agrupado (Node, un navegador de hoy) no cambia.
 */
export function groupThousands(text: string): string {
  return text.replace(/\d{4,}/, (run) => run.replace(/\B(?=(\d{3})+$)/g, '.'));
}

/** n / unit al más cercano, la mitad hacia arriba, con enteros (en coma flotante 9,95 se queda en 9,9). */
const halfUp = (n: number, unit: number): number => Math.floor((n + unit / 2) / unit);

/**
 * El importe corto de los gráficos, al más cercano: euros hasta 999,5 €; miles
 * con un decimal y sin «,0» hasta 9.950 € («3,1 mil €») y enteros después
 * («12 mil €»); desde 999.500 €, millones igual («1,2 M €»).
 */
function shortMoney(cents: number, currency: string): string {
  const abs = Math.abs(cents);
  const unit = abs < 99_950 ? 100 : abs < 99_950_000 ? 100_000 : 100_000_000;
  // Con decimal solo por debajo de 9,95 unidades (nunca en euros sueltos): en décimas.
  const tenths = unit > 100 && abs * 100 < unit * 995 ? halfUp(abs, unit / 10) : halfUp(abs, unit) * 10;
  const figure = `${groupThousands(String(Math.floor(tenths / 10)))}${tenths % 10 === 0 ? '' : `,${tenths % 10}`}`;
  const word = unit === 100 ? '' : unit === 100_000 ? '\u00a0mil' : '\u00a0M';
  return `${cents < 0 ? MINUS_SIGN : ''}${figure}${word}\u00a0${currency === 'EUR' ? '€' : currency}`;
}

/**
 * Un importe para la pantalla, igual en todas partes: «1.109,50 €», con
 * `compact` «33 €» (sin «,00» si no hay céntimos), y «−12 €» con el signo
 * menos de verdad. Los importes viajan en céntimos. Una moneda que Intl no
 * conoce sale como cifra y código («12,00 XYZ»).
 */
export function formatMoney(
  cents: number,
  { compact = false, locale = 'es-ES', currency = 'EUR', bare = false, short = false }: MoneyFormatOptions = {},
): string {
  if (short) return shortMoney(cents, currency);
  // Solo se quitan los «,00»: un importe con céntimos (12,50 €) nunca se redondea.
  const digits = compact && cents % 100 === 0 ? 0 : 2;
  const fmt = moneyFormat(locale, currency, digits, bare);
  const plain = (cents / 100).toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const text = fmt ? fmt.format(cents / 100) : bare ? plain : `${plain} ${currency}`;
  return (locale === 'es-ES' ? groupThousands(text) : text).replace('-', MINUS_SIGN);
}
