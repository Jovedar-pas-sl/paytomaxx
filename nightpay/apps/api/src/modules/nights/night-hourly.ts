import { fillHours, hourOf } from '../../common/time/hour-fill';
import type { CobroRow, RecargaEfectivoRow } from '../reports/export-rows';

/** Como mucho un día de horas (las últimas). */
export const MAX_NIGHT_HOURS = 24;

/** Lo pagado en una hora de la noche abierta. */
export interface NightHour {
  /** Inicio de la hora, en UTC. */
  at: string;
  chargedCents: number;
  /** La hora de ahora (aún sumando). */
  open: boolean;
}

export interface NightHourlyRows {
  cobros: ReadonlyArray<Pick<CobroRow, 'paidAt' | 'amountCents' | 'tipCents' | 'serviceFeeCents'>>;
  recargasEfectivo: ReadonlyArray<Pick<RecargaEfectivoRow, 'at' | 'amountCents' | 'serviceFeeCents'>>;
}

/**
 * Lo pagado de la noche abierta hora a hora (el minigráfico del Resumen), con
 * las mismas sumas que «Pagado esta noche» (summarize.chargedCents): cada
 * cobro por su `paidAt` con importe + propina + comisión del servicio, y cada
 * recarga en efectivo por su `at` con su comisión (las anuladas, en negativo,
 * restan). Puro: salen de las filas del Z que ya se leen.
 */
export function nightHourly(rows: NightHourlyRows, now: Date): NightHour[] {
  const byHour = new Map<number, number>();
  const add = (at: Date, cents: number) => byHour.set(hourOf(at), (byHour.get(hourOf(at)) ?? 0) + cents);
  for (const c of rows.cobros) add(c.paidAt, c.amountCents + c.tipCents + (c.serviceFeeCents ?? 0));
  for (const r of rows.recargasEfectivo) add(r.at, r.amountCents + (r.serviceFeeCents ?? 0));
  // `to` es el final de la ventana (sin incluir): justo a las 23:00:00, la hora abierta ya es la de las 23.
  return fillHours(byHour, { to: new Date(now.getTime() + 1), live: true }, MAX_NIGHT_HOURS).map((h) => ({ at: h.at, chargedCents: h.cents, open: h.open }));
}
