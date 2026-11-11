// «Los más pedidos arriba», fijo cada noche. Funciones puras: el servicio lee y
// guarda; aquí solo se cuenta y se ordena.

/** Cuántas noches cerradas miran las unidades vendidas. */
export const POPULARITY_NIGHTS = 4;

/** Lo que guarda la noche al pedir la carta por primera vez. */
export interface CartaOrderSnapshot {
  computedAt: string;
  /** Unidades vendidas de cada producto activo en esa fecha (0 incluido). */
  units: Record<string, number>;
}

/** Una línea vendida: el producto, cuántas unidades y si el cobro llegó a pagarse. */
export interface SoldLine {
  serviceItemId: string | null;
  qty: number;
  paid: boolean;
}

/** Unidades vendidas de cada producto activo (las líneas sin pagar o de otro producto no cuentan). */
export function unitsByItem(activeIds: readonly string[], lines: readonly SoldLine[]): Record<string, number> {
  const units: Record<string, number> = Object.fromEntries(activeIds.map((id) => [id, 0]));
  for (const l of lines) {
    if (!l.paid || !l.serviceItemId || !(l.serviceItemId in units)) continue;
    units[l.serviceItemId] = (units[l.serviceItemId] ?? 0) + Math.max(0, l.qty);
  }
  return units;
}

/** La forma guardada, comprobada: cualquier otra cosa (JSON raro de antes) no vale. */
export function readSnapshot(raw: unknown): CartaOrderSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const { computedAt, units } = raw as Partial<CartaOrderSnapshot>;
  if (typeof computedAt !== 'string' || !units || typeof units !== 'object') return null;
  const clean: Record<string, number> = {};
  for (const [id, n] of Object.entries(units)) if (typeof n === 'number' && Number.isFinite(n)) clean[id] = n;
  return { computedAt, units: clean };
}

/**
 * Los más vendidos primero. Empates y productos sin ventas: el orden manual de
 * siempre (el que traen las filas, sortOrder y precio). Un producto que no
 * estaba al calcular (nuevo de esta noche): al final. Estable: no cambia
 * mientras el snapshot sea el mismo.
 */
export function sortByPopularity<T extends { id: string }>(rowsInManualOrder: readonly T[], snapshot: CartaOrderSnapshot): T[] {
  return rowsInManualOrder
    .map((row, index) => ({ row, index, known: row.id in snapshot.units, units: snapshot.units[row.id] ?? 0 }))
    .sort((a, b) => Number(!a.known) - Number(!b.known) || b.units - a.units || a.index - b.index)
    .map((x) => x.row);
}
