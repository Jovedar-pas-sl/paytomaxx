/** CORS_ORIGINS (CSV) → lista de orígenes permitidos. */
export function parseCorsOrigins(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Orígenes de CORS (HTTP y Socket.io): en producción solo CORS_ORIGINS (sin
 * lista, ninguno); en local, cualquiera.
 */
export function corsOrigin(isProd: boolean, allowed: ReadonlyArray<string>): boolean | string[] {
  if (!isProd) return true;
  return allowed.length > 0 ? [...allowed] : false;
}

/**
 * ¿Se acepta la conexión de Socket.io con esta cabecera Origin? Los
 * navegadores la mandan siempre: en producción tiene que estar en
 * CORS_ORIGINS. Sin Origin (apps nativas, scripts) se acepta: lo que protege
 * los datos es la sesión, no CORS.
 */
export function socketOriginAllowed(origin: unknown, isProd: boolean, allowed: ReadonlyArray<string>): boolean {
  if (!isProd || origin === undefined) return true;
  return typeof origin === 'string' && allowed.includes(origin);
}
