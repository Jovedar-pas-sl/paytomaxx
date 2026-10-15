// Fechas del panel: siempre en la zona horaria del local (por defecto Madrid),
// no en la del navegador de quien mira.

export const DEFAULT_TIMEZONE = 'Europe/Madrid';

/** Los informes y las devoluciones del banco van por días de Madrid (igual que el API). */
export const MADRID_TIMEZONE = 'Europe/Madrid';

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
  | 'date';

const STYLE_OPTIONS: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  datetime: { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' },
  short: { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' },
  compact: { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' },
  time: { hour: '2-digit', minute: '2-digit' },
  weekday: { weekday: 'short', day: '2-digit', month: '2-digit' },
  date: { day: '2-digit', month: '2-digit', year: 'numeric' },
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

/** Hoy en Madrid ("AAAA-MM-DD"): lo que el API toma por "hoy" en devoluciones e informes. */
export function madridToday(now: Date = new Date()): string {
  return dayInZone(now, MADRID_TIMEZONE);
}

/** "AAAA-MM-DD" de un día del calendario (mes 0-11; desborda como Date: día 0 = último del mes anterior). */
function isoDay(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

export type ReportPreset = 'lastMonth' | 'thisMonth' | 'lastQuarter' | 'thisYear';

/** Periodos rápidos de los informes, en días de Madrid (como el API), se mire desde donde se mire. */
export function presetRange(preset: ReportPreset, now: Date): { from: string; to: string } {
  const today = madridToday(now);
  const [y, m1] = today.split('-').map(Number) as [number, number];
  const m = m1 - 1;
  switch (preset) {
    case 'lastMonth':
      return { from: isoDay(y, m - 1, 1), to: isoDay(y, m, 0) };
    case 'thisMonth':
      return { from: isoDay(y, m, 1), to: today };
    case 'lastQuarter': {
      const q = Math.floor(m / 3);
      return { from: isoDay(y, (q - 1) * 3, 1), to: isoDay(y, q * 3, 0) };
    }
    case 'thisYear':
      return { from: isoDay(y, 0, 1), to: today };
  }
}

/** Último día del mes de "AAAA-MM-DD". */
export function lastDayOfMonth(day: string): string {
  const [y, m] = day.split('-').map(Number) as [number, number];
  return isoDay(y, m, 0);
}

/** Un periodo vale si las dos fechas están puestas y la final no es anterior a la inicial. */
export function isValidRange(from: string, to: string): boolean {
  return Boolean(from) && Boolean(to) && to >= from;
}
