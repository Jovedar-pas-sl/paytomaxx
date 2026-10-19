import { CUTOFF_OFF, isValidCutoff, parseCutoff } from './date-cutoff';

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
export const LEGACY_SUBSCRIBE_OFF = CUTOFF_OFF;

export const LEGACY_SUBSCRIBE_UNTIL_HINT =
  'Fecha y hora ISO con zona (p. ej. 2026-11-15T00:00:00+01:00) u "off" para apagarla ya';

export function isValidLegacySubscribeUntil(raw: string | undefined): boolean {
  return isValidCutoff(raw);
}

/** Hasta cuándo vale la vía sin sesión; null = apagada. Lanza si el valor no vale. */
export function legacySubscribeUntil(raw: string | undefined): Date | null {
  return parseCutoff(raw, {
    defaultUntil: LEGACY_SUBSCRIBE_DEFAULT_UNTIL,
    envVar: 'REALTIME_LEGACY_SUBSCRIBE_UNTIL',
    hint: LEGACY_SUBSCRIBE_UNTIL_HINT,
  });
}
