// La verificación del momento y las llaves de acceso (lógica pura de las
// pantallas): qué decir de cada error y cuánto le queda a la verificación.

import { ApiError } from './api-errors';

/** Lo que se dice de cada error de la llave o de la verificación (null: no hay nada que decir, p. ej. canceló). */
const TEXTS: Readonly<Record<string, string>> = {
  PASSKEY_NOT_SET: 'No tienes ninguna llave de acceso: dala de alta en Ajustes → Seguridad.',
  TOTP_REQUIRED: 'Tienes la verificación en dos pasos: usa su código.',
  TOTP_NOT_ENROLLED: 'Para esto hace falta la verificación en dos pasos o una llave de acceso. Actívala en Ajustes → Seguridad.',
  PASSKEY_TIMEOUT: 'Ha tardado demasiado. Vuelve a intentarlo.',
  PASSKEY_USED: 'Esa confirmación ya se usó. Vuelve a intentarlo.',
  PASSKEY_FAILED: 'No se ha podido comprobar la llave. Vuelve a intentarlo.',
  PASSKEY_UNKNOWN: 'Esa llave no es tuya.',
  PASSKEY_LIMIT: 'Ya tienes 5 llaves: quita una antes de añadir otra.',
  PASSKEY_EXISTS: 'Esa llave ya está dada de alta.',
  PASSWORD_INVALID: 'La contraseña no es correcta.',
  STEP_UP_REQUIRED: 'Para ver esto, verifícate antes.',
};

export function stepUpErrorText(err: unknown): string | null {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === 'NotAllowedError' || name === 'AbortError') return null;
  if (err instanceof ApiError && err.code && TEXTS[err.code]) return TEXTS[err.code]!;
  return err instanceof Error ? err.message : 'No se ha podido verificar. Vuelve a intentarlo.';
}

/** «Verificado: te quedan 4 min» (null si ya no vale). */
export function verifiedLeftText(verifiedUntil: string | null, nowMs: number): string | null {
  if (!verifiedUntil) return null;
  const left = Date.parse(verifiedUntil) - nowMs;
  if (!(left > 0)) return null;
  const minutes = Math.max(1, Math.ceil(left / 60_000));
  return `Verificado: te ${minutes === 1 ? 'queda 1 min' : `quedan ${minutes} min`}.`;
}
