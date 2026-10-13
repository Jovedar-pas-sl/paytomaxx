/**
 * Fechas en hora de Madrid (los locales trabajan en hora peninsular). Sin
 * dependencias: Intl hace el cambio de horario de verano.
 */
export const MADRID_TZ = 'Europe/Madrid';

const DAY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: MADRID_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const PARTS_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: MADRID_TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Día de Madrid de un instante, como "AAAA-MM-DD". */
export function madridDay(d: Date = new Date()): string {
  return DAY_FMT.format(d);
}

/** Minutos que Madrid va por delante de UTC en ese instante (60 o 120). */
function madridOffsetMinutes(d: Date): number {
  const parts = Object.fromEntries(PARTS_FMT.formatToParts(d).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60_000);
}

/** Instante de la hora `hour`:00 del día "AAAA-MM-DD" en Madrid. */
export function madridAt(day: string, hour: number): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const utcWall = Date.UTC(y, m - 1, d, hour);
  // El desfase de esa hora local: primera aproximación y corrección (los
  // cambios de hora son a las 02:00/03:00, nunca a las 00:00 ni a las 08:00).
  const guess = new Date(utcWall - madridOffsetMinutes(new Date(utcWall)) * 60_000);
  return new Date(utcWall - madridOffsetMinutes(guess) * 60_000);
}

/** Instante en que empieza el día "AAAA-MM-DD" en Madrid (00:00 hora local). */
export function madridStartOfDay(day: string): Date {
  return madridAt(day, 0);
}

/** Hora a la que termina una noche (cierre automático): las 08:00 de Madrid. */
export const NIGHT_CUTOFF_HOUR = 8;

/** Últimas 08:00 de Madrid que ya han pasado: donde empieza la noche en curso. */
export function lastNightCutoff(now: Date = new Date()): Date {
  const today = madridAt(madridDay(now), NIGHT_CUTOFF_HOUR);
  return today <= now ? today : madridAt(previousDay(madridDay(now)), NIGHT_CUTOFF_HOUR);
}

/** Primeras 08:00 de Madrid posteriores a `after`. */
export function nextNightCutoff(after: Date): Date {
  const today = madridAt(madridDay(after), NIGHT_CUTOFF_HOUR);
  return today > after ? today : madridAt(nextDay(madridDay(after)), NIGHT_CUTOFF_HOUR);
}

function previousDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** "AAAA-MM-DD" del día siguiente (calendario, sin horas). */
export function nextDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
