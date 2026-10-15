import { madridDay, madridStartOfDay } from '../../common/time/madrid';
import type { TimeWindow } from './report-period';

/**
 * Ventanas de tiempo de los informes del panel (métricas, Z del periodo e
 * IVA 303): días, meses y trimestres de Madrid, con su cambio de hora. Son las
 * mismas que usan el informe de la gestoría (report-period.ts) y las noches:
 * ningún informe corta por días UTC del servidor.
 */

/** Un mes de Madrid ("AAAA-MM") y su intervalo [from, to). */
export interface MonthWindow extends TimeWindow {
  month: string;
}

/** Un trimestre ("Q1-2026") y sus tres meses: sus totales son la suma de los meses. */
export interface QuarterWindow extends TimeWindow {
  label: string;
  months: MonthWindow[];
}

const QUARTER = /^Q([1-4])-(\d{4})$/;

/** Hoy en Madrid: desde las 00:00 de Madrid hasta `now`. */
export function madridTodayWindow(now: Date): TimeWindow {
  return { from: madridStartOfDay(madridDay(now)), to: now };
}

/** Lo que va de hoy más los `days` días anteriores (días enteros de Madrid). */
export function madridRecentDaysWindow(now: Date, days: number): TimeWindow {
  return { from: madridStartOfDay(shiftDay(madridDay(now), -days)), to: now };
}

/**
 * Trimestre pedido ("Q1-2026") o, sin él, el de hoy en Madrid, con sus tres
 * meses. Lanza Error si el formato no vale (el controlador ya lo valida).
 */
export function madridQuarter(quarter: string | undefined, now: Date = new Date()): QuarterWindow {
  const { year, q } = parseQuarter(quarter, now);
  const months = [1, 2, 3].map((i) => monthWindow(year, (q - 1) * 3 + i));
  return { label: `Q${q}-${year}`, from: months[0]!.from, to: months[2]!.to, months };
}

function parseQuarter(quarter: string | undefined, now: Date): { year: number; q: number } {
  if (quarter) {
    const m = QUARTER.exec(quarter);
    if (!m) throw new Error('invalid quarter format');
    return { year: Number(m[2]), q: Number(m[1]) };
  }
  const [year, month] = madridDay(now).split('-').map(Number) as [number, number];
  return { year, q: Math.floor((month - 1) / 3) + 1 };
}

/** Mes `month` (1-12): de las 00:00 de Madrid del día 1 a las del día 1 siguiente. */
function monthWindow(year: number, month: number): MonthWindow {
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    month: `${year}-${pad(month)}`,
    from: madridStartOfDay(`${year}-${pad(month)}-01`),
    to: madridStartOfDay(`${nextYear}-${pad(nextMonth)}-01`),
  };
}

/** "AAAA-MM-DD" desplazado `days` días de calendario. */
function shiftDay(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
