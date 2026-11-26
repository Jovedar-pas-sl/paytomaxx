// Importes en español de España: el formato de toda la app (formatMoney de
// @nightpay/contracts): coma decimal, el punto de los miles siempre
// («1.234,50 €») y el signo menos de verdad («−3,00 €»). Los importes viajan
// en céntimos enteros. Y las fechas, los «hace…» y los «%», iguales en las
// tres apps (Piezas I).

import { formatMoney } from '@nightpay/contracts';

/** 4850 → "48,50 €"; 123450 → "1.234,50 €". */
export function formatEur(cents: number): string {
  return formatMoney(cents);
}

// ─── Porcentajes ───────────────────────────────────────────────────────

/** 37.5 → «37,5 %» (espacio duro antes del «%», sin «,0»). Un decimal como mucho, salvo que se pidan otros. */
export function formatPercent(percent: number, maxDecimals = 1): string {
  return `${percent.toLocaleString('es-ES', { maximumFractionDigits: maxDecimals })}\u00a0%`;
}

/** Comisión en puntos básicos (3750 → «37,5 %»), sin redondear a entero. */
export function formatBps(bps: number): string {
  return formatPercent(bps / 100, 2);
}

// ─── Fechas: siempre en la zona horaria del local (por defecto Madrid),
// no en la del navegador de quien mira ─────────────────────────────────

export const DEFAULT_TIMEZONE = 'Europe/Madrid';

export type DateStyle =
  /** 15/10/2026, 21:30 */
  | 'datetime'
  /** 15 oct, 21:30 */
  | 'short'
  /** 15/10, 21:30 */
  | 'compact'
  /** 21:30 */
  | 'time'
  /** jue, 15/10 */
  | 'weekday'
  /** 15/10/2026 */
  | 'date'
  /** 5 nov */
  | 'dayMonth'
  /** 5 nov 2025 */
  | 'dayMonthYear';

const STYLE_OPTIONS: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  datetime: { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' },
  short: { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' },
  compact: { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' },
  time: { hour: '2-digit', minute: '2-digit' },
  weekday: { weekday: 'short', day: '2-digit', month: '2-digit' },
  date: { day: '2-digit', month: '2-digit', year: 'numeric' },
  dayMonth: { day: 'numeric', month: 'short' },
  dayMonthYear: { day: 'numeric', month: 'short', year: 'numeric' },
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string, style: DateStyle): Intl.DateTimeFormat {
  const key = `${timeZone}|${style}`;
  const cached = formatters.get(key);
  if (cached) return cached;
  let created: Intl.DateTimeFormat;
  try {
    created = new Intl.DateTimeFormat('es-ES', { ...STYLE_OPTIONS[style], timeZone });
  } catch {
    // Zona horaria que el navegador no conoce: la de Madrid antes que romper la pantalla.
    created = new Intl.DateTimeFormat('es-ES', { ...STYLE_OPTIONS[style], timeZone: DEFAULT_TIMEZONE });
  }
  formatters.set(key, created);
  return created;
}

/** Instante (ISO o Date) → texto en la zona del local. Una fecha ilegible sale como "—". */
export function formatDateTime(
  value: string | Date,
  timeZone: string = DEFAULT_TIMEZONE,
  style: DateStyle = 'datetime',
): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return formatterFor(timeZone || DEFAULT_TIMEZONE, style).format(date);
}

const DAY_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/** Día del calendario de esa zona en ese instante, como "AAAA-MM-DD". */
export function dayInZone(now: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  let fmt = DAY_FORMATTERS.get(timeZone);
  if (!fmt) {
    const options: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit' };
    try {
      fmt = new Intl.DateTimeFormat('en-CA', { ...options, timeZone });
    } catch {
      fmt = new Intl.DateTimeFormat('en-CA', { ...options, timeZone: DEFAULT_TIMEZONE });
    }
    DAY_FORMATTERS.set(timeZone, fmt);
  }
  return fmt.format(now);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** Una noche va de 08:00 a 08:00: la de un instante es el día de 8 horas antes. */
const NIGHT_SHIFT_MS = 8 * HOUR_MS;

/**
 * Hace cuánto pasó algo, igual en las tres apps: «ahora» (menos de un minuto,
 * o un reloj atrasado), «hace 12 min», «hace 3 h» (hasta 12 horas, hacia
 * abajo), «hoy, 09:10», «ayer, 21:30» y, más atrás, «15 nov, 21:30» (de otro
 * año, «15 nov 2025, 21:30»). «Hoy» y «ayer» van por noches, como en las
 * fichas: a las 3 de la madrugada, lo de las 23:00 es «hoy». Ilegible, «—».
 */
export function formatRelative(at: string | Date, now: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  const date = typeof at === 'string' ? new Date(at) : at;
  const ms = now.getTime() - date.getTime();
  if (Number.isNaN(ms)) return '—';
  if (ms < MINUTE_MS) return 'ahora';
  if (ms < HOUR_MS) return `hace ${Math.floor(ms / MINUTE_MS)} min`;
  if (ms < 12 * HOUR_MS) return `hace ${Math.floor(ms / HOUR_MS)} h`;
  const time = formatDateTime(date, timeZone, 'time');
  const night = (d: Date): string => dayInZone(new Date(d.getTime() - NIGHT_SHIFT_MS), timeZone);
  if (night(date) === night(now)) return `hoy, ${time}`;
  if (night(date) === night(new Date(now.getTime() - 24 * HOUR_MS))) return `ayer, ${time}`;
  const sameYear = dayInZone(date, timeZone).slice(0, 4) === dayInZone(now, timeZone).slice(0, 4);
  // Sin el punto de la abreviatura («nov.» en algunos navegadores).
  return `${formatDateTime(date, timeZone, sameYear ? 'dayMonth' : 'dayMonthYear').replace('.', '')}, ${time}`;
}
