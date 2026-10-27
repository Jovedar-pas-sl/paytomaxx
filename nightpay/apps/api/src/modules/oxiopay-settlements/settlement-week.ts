import { NIGHT_CUTOFF_HOUR, lastNightCutoff, madridAt, madridDay, nextDay } from '../../common/time/madrid';

/**
 * La semana de la «Liquidación OxioPay»: de lunes 08:00 a lunes 08:00 de
 * Madrid, el mismo corte de las noches (common/time/madrid.ts). Con el cambio
 * de hora dura 169 h (octubre) o 167 h (marzo): las horas son las de Madrid.
 * Cada noche, de 08:00 a 08:00, lleva el día en que empieza.
 */
export interface SettlementWeek {
  /** Lunes 08:00 de Madrid (incluido). */
  from: Date;
  /** Lunes siguiente 08:00 de Madrid (excluido). */
  to: Date;
  /** El lunes, AAAA-MM-DD. */
  monday: string;
  isoYear: number;
  isoWeek: number;
}

export interface SettlementNightWindow {
  /** AAAA-MM-DD de las 08:00 en que empieza. */
  day: string;
  from: Date;
  to: Date;
}

/**
 * El repaso genera la semana terminada el lunes desde esta hora de Madrid:
 * después del corte de las 08:00 (cierre automático de las noches) y del
 * resumen de las 9:00 (incidents/alerts.service.ts).
 */
export const GENERATE_FROM_HOUR = 10;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function utcDate(day: string): Date {
  if (!DAY.test(day)) throw new Error(`Día no válido: ${day}`);
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    throw new Error(`Día no válido: ${day}`);
  }
  return date;
}

function addDays(day: string, n: number): string {
  return new Date(utcDate(day).getTime() + n * DAY_MS).toISOString().slice(0, 10);
}

/** 1 = lunes … 7 = domingo. */
function isoWeekday(day: string): number {
  return utcDate(day).getUTCDay() || 7;
}

/** Semana ISO 8601 de un día (la del jueves de esa semana). */
export function isoWeekOf(day: string): { isoYear: number; isoWeek: number } {
  const date = utcDate(day);
  const thursday = new Date(date.getTime() + (4 - isoWeekday(day)) * DAY_MS);
  const isoYear = thursday.getUTCFullYear();
  const dayOfYear = Math.floor((thursday.getTime() - Date.UTC(isoYear, 0, 1)) / DAY_MS) + 1;
  return { isoYear, isoWeek: Math.floor((dayOfYear - 1) / 7) + 1 };
}

/** La semana que empieza el lunes `monday` (AAAA-MM-DD). */
export function weekStartingOn(monday: string): SettlementWeek {
  if (isoWeekday(monday) !== 1) throw new Error(`La semana de la liquidación empieza en lunes (${monday} no lo es)`);
  return {
    from: madridAt(monday, NIGHT_CUTOFF_HOUR),
    to: madridAt(addDays(monday, 7), NIGHT_CUTOFF_HOUR),
    monday,
    ...isoWeekOf(monday),
  };
}

/** La semana cuyo [from, to) contiene el instante. */
export function weekContaining(t: Date): SettlementWeek {
  // El día de la noche en curso (las 08:00 que ya pasaron) y su lunes.
  const nightDay = madridDay(lastNightCutoff(t));
  return weekStartingOn(addDays(nightDay, 1 - isoWeekday(nightDay)));
}

/** La última semana que ya terminó (acaba en el último lunes 08:00 que ha pasado). */
export function lastCompletedWeek(now: Date): SettlementWeek {
  return previousWeeks(weekContaining(now), 1)[0]!;
}

/** La semana que el repaso tiene que tener generada; null si aún no toca (lunes antes de las 10:00). */
export function dueWeek(now: Date): SettlementWeek | null {
  const week = lastCompletedWeek(now);
  return now >= madridAt(madridDay(week.to), GENERATE_FROM_HOUR) ? week : null;
}

/** Las `count` semanas anteriores, de la más reciente a la más antigua. */
export function previousWeeks(week: SettlementWeek, count: number): SettlementWeek[] {
  return Array.from({ length: count }, (_, i) => weekStartingOn(addDays(week.monday, -7 * (i + 1))));
}

/** La primera semana que empieza después de `now` (el lunes 08:00 siguiente): la semana de inicio al desplegar. */
export function nextWeekAfter(now: Date): SettlementWeek {
  return weekStartingOn(addDays(weekContaining(now).monday, 7));
}

/** Las semanas desde `start` (incluida) que empiezan antes de `before`, en orden. */
export function weeksBetween(start: SettlementWeek, before: Date): SettlementWeek[] {
  const out: SettlementWeek[] = [];
  for (let w = start; w.from < before; w = weekStartingOn(addDays(w.monday, 7))) out.push(w);
  return out;
}

/** Las 7 noches de la semana (08:00 → 08:00), en orden. */
export function nightsOf(week: SettlementWeek): SettlementNightWindow[] {
  return Array.from({ length: 7 }, (_, i) => {
    const day = addDays(week.monday, i);
    return { day, from: madridAt(day, NIGHT_CUTOFF_HOUR), to: madridAt(nextDay(day), NIGHT_CUTOFF_HOUR) };
  });
}

/** Tope de la referencia (lo que caben en el concepto de una transferencia SEPA). */
const MAX_REFERENCE = 140;

/**
 * «OXP-2026-S44-LUNA-VLC» y, si se regenera tras anularla, «…/R2», «…/R3».
 * El slug solo deja A-Z, 0-9 y guiones: la barra del sufijo no puede salir de
 * ningún slug (el local «luna-2» no choca con la regenerada de «luna»). Todo
 * vale en el concepto de una transferencia SEPA (letras, cifras, - y /).
 */
export function settlementReference(week: Pick<SettlementWeek, 'isoYear' | 'isoWeek'>, slug: string, n = 1): string {
  const head = `OXP-${week.isoYear}-S${String(week.isoWeek).padStart(2, '0')}-`;
  const tail = n > 1 ? `/R${n}` : '';
  const clean =
    slug
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'LOCAL';
  return `${head}${clean.slice(0, MAX_REFERENCE - head.length - tail.length).replace(/-+$/, '')}${tail}`;
}
