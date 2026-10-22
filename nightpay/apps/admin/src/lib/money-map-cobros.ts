// Del mapa del dinero a la lista de Cobros (lógica pura): tocar una sección,
// «Del saldo» o las ventas abre los cobros que explican esa cifra, con la
// misma ventana de fechas que el mapa.

import { MONEY_MAP_TIPS, type MoneyMap } from '@nightpay/contracts';
import type { CobrosFilters } from './endpoints/money-map';
import { moneyMapIsCurrent } from './money-map-view';

/** Lo que se puede abrir desde el mapa. */
export type MoneyMapTarget =
  | { kind: 'sales' }
  | { kind: 'section'; code: string }
  | { kind: 'saldo' };

/** ¿Se puede abrir en Cobros? (las propinas no son una sección de la lista). */
export function canOpenSection(code: string): boolean {
  return code !== MONEY_MAP_TIPS;
}

/**
 * Los filtros de Cobros para una cifra del mapa: sus fechas (abiertas por
 * arriba si el mapa va en directo) y su sección o forma de pago. La lista va
 * por la hora del cobro.
 */
export function moneyMapCobrosFilter(map: Pick<MoneyMap, 'from' | 'to' | 'frozen' | 'scope'>, target: MoneyMapTarget): CobrosFilters {
  const window: CobrosFilters = moneyMapIsCurrent(map) ? { from: map.from } : { from: map.from, to: map.to };
  if (target.kind === 'section') return { ...window, category: target.code };
  if (target.kind === 'saldo') return { ...window, method: 'SALDO' };
  return window;
}
