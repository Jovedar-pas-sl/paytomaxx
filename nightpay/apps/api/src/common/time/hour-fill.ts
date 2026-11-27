/**
 * Las horas de una gráfica, seguidas (las que no tienen nada, a 0): de la
 * primera con movimiento a la de `to` (en directo) o a la última con
 * movimiento. La de ahora, `open`. Como mucho `max` (las últimas). Puro: lo
 * usan el panel en directo de OxioParty (party-live-rules.hourlyOf) y la
 * noche abierta de OxioPay (nights/night-hourly).
 */

export const HOUR_MS = 3_600_000;

export interface FilledHour {
  /** Inicio de la hora, en UTC. */
  at: string;
  cents: number;
  open: boolean;
}

/** La hora desde 1970 de un instante (floor(epoch / 3600)). */
export function hourOf(at: Date): number {
  return Math.floor(at.getTime() / HOUR_MS);
}

/** `byHour`: hora desde 1970 → céntimos. */
export function fillHours(byHour: ReadonlyMap<number, number>, window: { to: Date; live: boolean }, max: number): FilledHour[] {
  if (byHour.size === 0) return [];
  const hours = [...byHour.keys()];
  const nowHour = Math.floor((window.to.getTime() - 1) / HOUR_MS);
  const last = window.live ? Math.max(nowHour, ...hours) : Math.max(...hours);
  const first = Math.max(Math.min(...hours), last - max + 1);
  const out: FilledHour[] = [];
  for (let h = first; h <= last; h += 1) {
    out.push({ at: new Date(h * HOUR_MS).toISOString(), cents: byHour.get(h) ?? 0, open: window.live && h === nowHour });
  }
  return out;
}
