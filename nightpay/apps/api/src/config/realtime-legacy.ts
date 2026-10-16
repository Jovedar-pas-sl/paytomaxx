/**
 * Tiempo real: `payment:subscribe` sin sesión del personal (apps antiguas
 * guardadas en caché). Se mantiene hasta una fecha y luego se apaga sola.
 *
 * REALTIME_LEGACY_SUBSCRIBE_UNTIL (opcional):
 *   - sin definir o vacía → LEGACY_SUBSCRIBE_DEFAULT_UNTIL
 *   - fecha y hora ISO con zona (p. ej. 2026-12-01T00:00:00+01:00) → hasta entonces
 *   - "off" → apagada ya
 */
export const LEGACY_SUBSCRIBE_DEFAULT_UNTIL = '2026-11-15T00:00:00+01:00';
export const LEGACY_SUBSCRIBE_OFF = 'off';

/** Fecha y hora con zona: 2026-11-15T00:00, :00 o :00.000, y Z o ±hh:mm. */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

export const LEGACY_SUBSCRIBE_UNTIL_HINT =
  'Fecha y hora ISO con zona (p. ej. 2026-11-15T00:00:00+01:00) u "off" para apagarla ya';

export function isValidLegacySubscribeUntil(raw: string | undefined): boolean {
  const value = raw?.trim() ?? '';
  if (value === '' || value.toLowerCase() === LEGACY_SUBSCRIBE_OFF) return true;
  return ISO_WITH_ZONE.test(value) && !Number.isNaN(Date.parse(value));
}

/** Hasta cuándo vale la vía sin sesión; null = apagada. Lanza si el valor no vale. */
export function legacySubscribeUntil(raw: string | undefined): Date | null {
  if (!isValidLegacySubscribeUntil(raw)) {
    throw new Error(`REALTIME_LEGACY_SUBSCRIBE_UNTIL no vale: ${LEGACY_SUBSCRIBE_UNTIL_HINT}`);
  }
  const value = raw?.trim() ?? '';
  if (value.toLowerCase() === LEGACY_SUBSCRIBE_OFF) return null;
  return new Date(value === '' ? LEGACY_SUBSCRIBE_DEFAULT_UNTIL : value);
}
