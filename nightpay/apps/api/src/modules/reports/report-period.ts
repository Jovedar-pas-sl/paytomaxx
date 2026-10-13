import { madridStartOfDay, nextDay } from '../../common/time/madrid';

/** Periodo de un informe: días de Madrid, ambos incluidos. */
export interface ReportPeriod {
  /** Primer instante (00:00 de Madrid del día `fromDay`). */
  from: Date;
  /** Fin exclusivo (00:00 de Madrid del día siguiente a `toDay`). */
  to: Date;
  fromDay: string;
  toDay: string;
}

/** Un informe no abarca más de un año (y así la consulta no se dispara). */
export const MAX_PERIOD_DAYS = 366;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type PeriodResult = { ok: true; period: ReportPeriod } | { ok: false; error: string };

export function parseReportPeriod(fromDay: string, toDay: string): PeriodResult {
  if (!DAY.test(fromDay) || !DAY.test(toDay) || !isRealDay(fromDay) || !isRealDay(toDay)) {
    return { ok: false, error: 'Fechas en formato AAAA-MM-DD' };
  }
  if (toDay < fromDay) return { ok: false, error: 'La fecha final es anterior a la inicial' };
  const from = madridStartOfDay(fromDay);
  const to = madridStartOfDay(nextDay(toDay));
  if (to.getTime() - from.getTime() > (MAX_PERIOD_DAYS + 1) * 86_400_000) {
    return { ok: false, error: `Como mucho ${MAX_PERIOD_DAYS} días por informe` };
  }
  return { ok: true, period: { from, to, fromDay, toDay } };
}

function isRealDay(day: string): boolean {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Para el nombre del archivo: "2026-10" si es un mes entero, si no "2026-10-01_2026-10-15". */
export function periodSlug(p: ReportPeriod): string {
  const sameMonth = p.fromDay.slice(0, 7) === p.toDay.slice(0, 7);
  const wholeMonth = sameMonth && p.fromDay.endsWith('-01') && nextDay(p.toDay).endsWith('-01');
  return wholeMonth ? p.fromDay.slice(0, 7) : `${p.fromDay}_${p.toDay}`;
}
