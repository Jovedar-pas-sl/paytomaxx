/**
 * Fecha de corte de una vía antigua (apps en caché que aún no se han
 * actualizado). Formato de la variable de entorno:
 *   - sin definir o vacía → la fecha por defecto de esa vía
 *   - fecha y hora ISO con zona (p. ej. 2026-12-01T00:00:00+01:00) → hasta entonces
 *   - "off" (como sea escrito) → cerrada ya
 */
export const CUTOFF_OFF = 'off';

/** Fecha y hora con zona: 2026-11-15T00:00, :00 o :00.000, y Z o ±hh:mm. */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

export function isValidCutoff(raw: string | undefined): boolean {
  const value = raw?.trim() ?? '';
  if (value === '' || value.toLowerCase() === CUTOFF_OFF) return true;
  return ISO_WITH_ZONE.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * Hasta cuándo sigue abierta la vía; null = cerrada. Lanza (con el nombre de
 * la variable y la pista) si el valor no vale.
 */
export function parseCutoff(
  raw: string | undefined,
  spec: { readonly defaultUntil: string; readonly envVar: string; readonly hint: string },
): Date | null {
  if (!isValidCutoff(raw)) throw new Error(`${spec.envVar} no vale: ${spec.hint}`);
  const value = raw?.trim() ?? '';
  if (value.toLowerCase() === CUTOFF_OFF) return null;
  return new Date(value === '' ? spec.defaultUntil : value);
}

/** ¿Sigue abierta en `now`? */
export function cutoffOpen(until: Date | null, now: number = Date.now()): boolean {
  return until !== null && now < until.getTime();
}
