/**
 * El historial con fechas de la app (Cobros, Ganancias y Pagos recibidos).
 * Las fechas que elige ella son noches de Madrid: de las 08:00 de ese día a
 * las 08:00 del siguiente (como «Ganancias» y el cierre automático), se mire
 * desde donde se mire. Sin React: se prueba en history.test.
 */

/** Los días del filtro, como los da el <input type="date"> («AAAA-MM-DD»); '' = sin esa fecha. */
export interface DayRange {
  fromDay: string;
  toDay: string;
}

export const NO_DAYS: DayRange = { fromDay: '', toDay: '' };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const NIGHT_STARTS_AT = 8;
/** Las páginas, de 50 en 50 (como «Cobros»). */
export const HISTORY_PAGE = 50;

const MADRID_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Madrid',
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
});

function dayParts(day: string): [number, number, number] {
  return day.split('-').map(Number) as [number, number, number];
}

/** El instante de las `hour`:00 de Madrid del día «AAAA-MM-DD» (con su hora de verano o de invierno). */
export function madridInstant(day: string, hour: number): Date {
  const [y, m, d] = dayParts(day);
  const asUtc = Date.UTC(y, m - 1, d, hour);
  // Lo que marca el reloj de Madrid en ese instante, leído como UTC: la diferencia es su adelanto.
  const p: Record<string, number> = {};
  for (const { type, value } of MADRID_CLOCK.formatToParts(asUtc)) p[type] = Number(value);
  const shown = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!);
  return new Date(asUtc - (shown - asUtc));
}

function nextDay(day: string): string {
  const [y, m, d] = dayParts(day);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** Para el API: desde las 08:00 del primer día hasta las 08:00 del día después del último (su noche entera). */
export function nightRange(r: DayRange): { from?: string; to?: string } {
  const out: { from?: string; to?: string } = {};
  if (DAY_RE.test(r.fromDay)) out.from = madridInstant(r.fromDay, NIGHT_STARTS_AT).toISOString();
  if (DAY_RE.test(r.toDay)) out.to = madridInstant(nextDay(r.toDay), NIGHT_STARTS_AT).toISOString();
  return out;
}

/** Lo que está mal en las fechas elegidas (null si nada). */
export function rangeProblem(r: DayRange): string | null {
  return DAY_RE.test(r.fromDay) && DAY_RE.test(r.toDay) && r.fromDay > r.toDay ? '«Desde» tiene que ser antes que «Hasta».' : null;
}

/** La consulta de una página: cuántas, las fechas y, para «Ver anteriores», el cursor. */
export function historyParams(r: DayRange, cursor?: string | null): URLSearchParams {
  const q = new URLSearchParams({ limit: String(HISTORY_PAGE) });
  const { from, to } = nightRange(r);
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  if (cursor) q.set('cursor', cursor);
  return q;
}

/** Lo cargado más la página siguiente, sin repetir una fila que ya estaba. */
export function appendPage<T extends { id: string }>(loaded: readonly T[], next: readonly T[]): T[] {
  const seen = new Set(loaded.map((x) => x.id));
  return [...loaded, ...next.filter((x) => !seen.has(x.id))];
}

/** El enlace del justificante, solo si es https (ni http, ni javascript:, ni nada raro). */
export function httpsUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
