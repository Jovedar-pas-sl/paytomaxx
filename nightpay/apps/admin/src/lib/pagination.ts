// Lista de pagos con "Cargar más": el refresco automático trae de nuevo la
// primera página y no debe tirar las páginas antiguas que ya se cargaron.

interface Row {
  id: string;
  createdAt: string;
}

/**
 * `fresh` = primera página recién pedida (lo más nuevo primero); `previous` =
 * lo que se enseñaba. Queda `fresh` y, detrás, lo anterior que es más antiguo
 * que lo último de `fresh` (las páginas cargadas con "Cargar más"). Lo que
 * estaba en la parte nueva y ya no viene (cambió de estado y no pasa el
 * filtro) desaparece.
 */
export function mergeLatestPage<T extends Row>(fresh: readonly T[], previous: readonly T[]): T[] {
  const oldest = fresh[fresh.length - 1];
  if (!oldest) return [];
  const freshIds = new Set(fresh.map((r) => r.id));
  const oldestTime = Date.parse(oldest.createdAt);
  const older = previous.filter((r) => !freshIds.has(r.id) && Date.parse(r.createdAt) < oldestTime);
  return [...fresh, ...older];
}

/** Añade una página antigua sin repetir filas. */
export function appendPage<T extends Row>(current: readonly T[], page: readonly T[]): T[] {
  const ids = new Set(current.map((r) => r.id));
  return [...current, ...page.filter((r) => !ids.has(r.id))];
}
