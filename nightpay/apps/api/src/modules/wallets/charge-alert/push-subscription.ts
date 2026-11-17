/**
 * Lo que manda el navegador al apuntarse (PushSubscription.toJSON()): la
 * dirección de su servicio de avisos y dos claves públicas. El servidor hará
 * POST a esa dirección: solo se aceptan los servicios de avisos de los
 * navegadores (https, sin puerto ni usuario), nunca una dirección cualquiera
 * (no se puede usar para que el servidor llame a otro sitio).
 */

/** Servicios de avisos de los navegadores (el dominio o uno de sus subdominios). */
export const PUSH_SERVICE_HOSTS: readonly string[] = Object.freeze([
  // Chrome, Android, Edge con FCM, Samsung Internet, Opera, Brave.
  'fcm.googleapis.com',
  'android.googleapis.com',
  // Firefox.
  'push.services.mozilla.com',
  // Safari (macOS, iPhone/iPad 16.4+ desde la pantalla de inicio).
  'push.apple.com',
  // Edge (Windows).
  'notify.windows.com',
]);

const MAX_ENDPOINT_LENGTH = 1024;
const P256DH_BYTES = 65;
const AUTH_BYTES = 16;
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

function knownHost(host: string): boolean {
  const h = host.toLowerCase();
  return PUSH_SERVICE_HOSTS.some((s) => h === s || h.endsWith(`.${s}`));
}

/** La dirección, si es la de un servicio de avisos de navegador (si no, null). */
export function pushEndpoint(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ENDPOINT_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !knownHost(url.hostname)) return null;
  return url.toString();
}

function keyOf(value: unknown, bytes: number): string | null {
  if (typeof value !== 'string' || !BASE64URL.test(value)) return null;
  const clean = value.replace(/=+$/, '');
  const raw = Buffer.from(clean, 'base64url');
  if (raw.length !== bytes) return null;
  // La clave pública de la curva P-256 sin comprimir empieza por 0x04.
  if (bytes === P256DH_BYTES && raw[0] !== 4) return null;
  return clean;
}

/** La suscripción que manda la página, comprobada (null si algo no cuadra). */
export function parsePushSubscription(body: unknown): PushSubscriptionInput | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as { endpoint?: unknown; keys?: unknown };
  const endpoint = pushEndpoint(b.endpoint);
  if (!endpoint || typeof b.keys !== 'object' || b.keys === null) return null;
  const keys = b.keys as { p256dh?: unknown; auth?: unknown };
  const p256dh = keyOf(keys.p256dh, P256DH_BYTES);
  const auth = keyOf(keys.auth, AUTH_BYTES);
  return p256dh && auth ? { endpoint, p256dh, auth } : null;
}
