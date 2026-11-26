// Fechas del panel: siempre en la zona horaria del local (por defecto Madrid),
// no en la del navegador de quien mira.

// formatDateTime y dayInZone viven en @nightpay/ui (los usa también formatRelative): aquí se reexportan.
import { dayInZone } from '@nightpay/ui';

export { DEFAULT_TIMEZONE, dayInZone, formatDateTime } from '@nightpay/ui';
export type { DateStyle } from '@nightpay/ui';

/** Los informes y las devoluciones del banco van por días de Madrid (igual que el API). */
export const MADRID_TIMEZONE = 'Europe/Madrid';

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
