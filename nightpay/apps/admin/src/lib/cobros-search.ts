/** Lo mínimo del buscador de código o referencia del banco en Cobros (como el API: el código tiene 3). */
export const SEARCH_MIN_CHARS = 3;

/** La búsqueda que se manda: vacía o de al menos 3; con menos, se queda la que había (el API la rechazaría). */
export function nextSearch(typed: string, current?: string): string {
  const t = typed.trim();
  return t === '' || t.length >= SEARCH_MIN_CHARS ? t : (current ?? '');
}
