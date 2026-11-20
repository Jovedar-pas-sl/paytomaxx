import type { PartyNight } from '@nightpay/contracts';
import { NIGHT_CUTOFF_HOUR, lastNightCutoff, madridAt, madridDay, nextDay } from '../../common/time/madrid';

/**
 * Las ventanas del panel de OxioParty. Una noche va de las 08:00 a las 08:00
 * de Madrid (como el cierre automático de OxioPay): «la noche del 23» empieza
 * el 23 a las 08:00 y acaba el 24 a las 08:00. La fiesta entera no tiene
 * principio: es todo lo de esta instalación (cada fiesta va en la suya),
 * también lo cargado desde casa antes de empezar.
 */

export interface PartyWindow {
  /** null: desde el principio. */
  from: Date | null;
  to: Date;
  /** Llega hasta ahora (la noche en curso, o la fiesta mientras dura). */
  live: boolean;
}

/** Las noches que se enseñan como mucho (una fiesta de un mes). */
export const MAX_PARTY_NIGHTS = 31;

/** La noche (AAAA-MM-DD) de un instante: antes de las 08:00, la del día anterior. */
export function nightOf(at: Date): string {
  const day = madridDay(at);
  if (at.getTime() >= madridAt(day, NIGHT_CUTOFF_HOUR).getTime()) return day;
  return madridDay(new Date(madridAt(day, NIGHT_CUTOFF_HOUR).getTime() - 12 * 3_600_000));
}

/** La noche de ese día: [día 08:00, día siguiente 08:00), cortada en ahora si aún no ha acabado. */
export function nightWindow(day: string, now: Date): PartyWindow {
  return nightsRange(day, day, now);
}

/** La noche en curso: desde las últimas 08:00 de Madrid. */
export function currentNightWindow(now: Date): PartyWindow {
  return { from: lastNightCutoff(now), to: now, live: true };
}

/** La fiesta entera: todo hasta ahora. En directo mientras no ha terminado. */
export function eventWindow(now: Date, ended: boolean): PartyWindow {
  return { from: null, to: now, live: !ended };
}

/**
 * Las noches de la fiesta (de la del inicio a la del fin, o a la de ahora si
 * no tiene fin), como mucho MAX_PARTY_NIGHTS. Sin inicio, ninguna.
 */
export function eventNights(startsAt: Date | null, endsAt: Date | null, now: Date): PartyNight[] {
  if (!startsAt) return [];
  const first = nightOf(startsAt);
  const last = nightOf(endsAt ?? (now.getTime() > startsAt.getTime() ? now : startsAt));
  const current = nightOf(now);
  const nights: PartyNight[] = [];
  for (let day = first; day <= last && nights.length < MAX_PARTY_NIGHTS; day = nextDay(day)) {
    nights.push({ day, current: day === current });
  }
  return nights;
}

/** Las noches [fromNight, toNight] (días AAAA-MM-DD): [fromNight 08:00, toNight+1 08:00), cortado en ahora. */
export function nightsRange(fromNight: string, toNight: string, now: Date): PartyWindow {
  const from = madridAt(fromNight, NIGHT_CUTOFF_HOUR);
  const end = madridAt(nextDay(toNight), NIGHT_CUTOFF_HOUR);
  // Una noche que aún no ha empezado: vacía (no en directo).
  if (from.getTime() > now.getTime()) return { from, to: from, live: false };
  const live = end.getTime() > now.getTime();
  return { from, to: live ? now : end, live };
}
