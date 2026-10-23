// «Hoy · pagos con tarjeta» y «Hoy · cobrado» en Cobros, junto a «Esta noche».
// «Esta noche» cuenta desde que se abrió la noche, no el día natural: pasada
// la medianoche (o si la noche abrió tarde) son cifras distintas. Se esconden
// solo cuando dicen exactamente lo mismo, y no se pintan hasta saberlo (nada
// aparece para desaparecer después).

import type { MetricsPeriod } from './endpoints/payments';

/** Lo que dice «Esta noche»: undefined = cargando; null = no hay noche abierta. */
export type NightTotals = { chargedCents: number; count: number } | null | undefined;

export type TodayTilesState = 'show' | 'hide' | 'wait';

export function todayTiles(
  night: NightTotals,
  today: Pick<MetricsPeriod, 'count' | 'grossCents' | 'chargedCents'> | undefined,
): TodayTilesState {
  if (night === undefined) return 'wait';
  if (night === null) return 'show';
  if (!today) return 'wait';
  const charged = today.chargedCents ?? today.grossCents;
  return charged === night.chargedCents && today.count === night.count ? 'hide' : 'show';
}
