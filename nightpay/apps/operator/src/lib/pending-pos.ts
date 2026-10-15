/**
 * ¿Ha llegado un cobro con datáfono nuevo desde la última vez? `seen` null es
 * la primera carga (o tras cambiar de zona): lo que ya había no avisa.
 */
export function newArrivals(
  seen: ReadonlySet<string> | null,
  ids: readonly string[],
): { seen: Set<string>; hasNew: boolean } {
  const next = new Set(ids);
  const hasNew = seen !== null && ids.some((id) => !seen.has(id));
  return { seen: next, hasNew };
}
