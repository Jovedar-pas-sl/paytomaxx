// API client TPV. La sesión es la del cliente común @nightpay/api-client
// (igual que el panel y la app de la chica): el refresh token va en una
// cookie HttpOnly del API y el access token solo en la memoria de la pestaña.

import {
  ApiError,
  SESSION_EXPIRED_EVENT,
  ServerUnavailableError,
  createApiClient,
  type LoginResult,
} from '@nightpay/api-client';
import type { PaymentStatus } from '@nightpay/ui';
import { MESSAGES, commonError, readError } from './http';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';

export const apiBase = API_BASE;
export const wsBase = process.env.NEXT_PUBLIC_WS_URL ?? API_BASE.replace(/^http/, 'ws');

/** Local de la sesión, de la versión antigua del TPV (antes no se guardaba quién era). */
const LEGACY_VENUE_KEY = 'np_tpv_venue';

/** Se lanza en window cuando la sesión muere (el API rechaza el refresh): la página vuelve al login. */
export { SESSION_EXPIRED_EVENT };

export interface TpvUser {
  id: string;
  email: string;
  role: string;
  tenantId: string;
  venueSlug: string;
}

/** Lo que devuelve el login: el access token (solo para la memoria) y quién es. El refresh va en la cookie. */
export type LoginResponse = LoginResult<TpvUser>;

export interface RefreshResponse {
  accessToken: string;
  expiresIn: number;
  refreshExpiresIn?: number;
}

export interface CreatedPayment {
  id: string;
  amountCents: number;
  currency: string;
  status: string;
  qrToken: string;
  qrUrl: string;
  qrPngDataUrl: string;
  qrExpiresAt: string;
  createdAt: string;
}

const client = createApiClient<TpvUser>({
  baseUrl: API_BASE,
  storagePrefix: 'np_tpv',
  messages: {
    sessionExpired: MESSAGES.session,
    network: MESSAGES.network,
    timeout: MESSAGES.timeout,
    server: MESSAGES.server,
    tooMany: MESSAGES.tooMany,
  },
  extraKeys: [LEGACY_VENUE_KEY],
});

// «Salir» o sesión caducada en otra pestaña, u otra persona entró allí: esta
// pestaña vuelve al login también (la página escucha SESSION_EXPIRED_EVENT).
if (typeof window !== 'undefined') {
  client.onSessionEvent((event) => {
    if (event.source === 'other-tab' && event.type !== 'signed-in') window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  });
}

/** El access token de esta pestaña (solo en memoria; null hasta el primer uso). */
export function getToken(): string | null {
  return client.getAccessToken();
}

/** ¿Hay sesión en este equipo? (la cookie dirá si sigue viva al primer uso). */
export function hasSession(): boolean {
  return client.hasSession();
}

/** Local de la sesión, para enseñarlo (no secreto). */
export function getVenueSlug(): string | null {
  if (typeof window === 'undefined') return null;
  const fromUser = client.getUser()?.venueSlug;
  if (fromUser) return fromUser;
  try {
    return window.localStorage.getItem(LEGACY_VENUE_KEY);
  } catch {
    return null;
  }
}

export function setSession(login: LoginResponse): void {
  client.setSession(login);
}

export function clearSession(): void {
  client.clearSession();
}

/** El access token para el socket: el vigente, renovado si está a punto de caducar. */
export function freshAccessToken(): Promise<string | null> {
  return client.freshAccessToken();
}

export async function login(email: string, password: string): Promise<LoginResponse> {
  try {
    return await client.login({ email, password });
  } catch (err) {
    if (err instanceof ServerUnavailableError) throw new Error(err.message);
    if (err instanceof ApiError) throw new Error(loginErrorText(err.status, err.message));
    throw err;
  }
}

function loginErrorText(status: number, detail: string): string {
  if (status === 401) {
    // El bloqueo por intentos también llega como 401 ("Too many attempts…").
    if (/too many|demasiados/i.test(detail)) return MESSAGES.tooMany;
    if (/disabled|desactivad/i.test(detail)) return 'Este usuario está desactivado. Habla con el encargado.';
    return 'Email o contraseña incorrectos.';
  }
  if (status === 400) return 'Revisa el email y la contraseña.';
  if (status === 429) return MESSAGES.tooMany;
  return MESSAGES.network;
}

/**
 * Cierra la sesión en este equipo siempre (y en las otras pestañas). Devuelve
 * si el API la cerró también (si no, la cookie caduca sola). Salir no hace
 * esperar: si el API no contesta en 5 s, ya se cerró aquí.
 */
export function logout(): Promise<boolean> {
  return client.logout();
}

function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return client.authedFetch(path, init);
}

/**
 * Crea el cobro. `idempotencyKey` es la del intento: la misma al reintentar
 * (un tiempo agotado + otro clic no crea dos QR), otra para cada cobro nuevo.
 */
export async function createPayment(
  input: { amountCents: number; terminalExternalId: string },
  idempotencyKey: string,
): Promise<CreatedPayment> {
  const res = await authedFetch(`/v1/payments`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(input),
  });
  if (res.ok) return (await res.json()) as CreatedPayment;
  if (res.status === 403) throw new Error('Tu usuario no puede cobrar desde el TPV. Habla con el encargado.');
  throw new Error(
    commonError(res.status) ?? (await readError(res, `No se pudo crear el cobro (error ${res.status}).`)),
  );
}

/**
 * Estado del cobro según el servidor (la misma consulta pública que la página
 * del cliente). Lanza si no hay respuesta válida: entonces no se sabe nada.
 */
export async function fetchPaymentStatus(
  qrToken: string,
  signal?: AbortSignal,
): Promise<{ id: string; status: PaymentStatus }> {
  const res = await client.publicFetch(`/v1/payments/public/${encodeURIComponent(qrToken)}`, {
    cache: 'no-store',
    signal,
  });
  if (!res.ok) throw new Error(commonError(res.status) ?? `No se pudo consultar el cobro (error ${res.status}).`);
  return (await res.json()) as { id: string; status: PaymentStatus };
}

/** Anula un cobro que aún no se ha pagado: su QR deja de valer. */
export async function cancelPayment(id: string): Promise<void> {
  const res = await authedFetch(`/v1/payments/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  if (res.ok) return;
  if (res.status === 409) {
    throw new Error('No se puede cancelar: el cliente ya está pagando o el cobro ya terminó. Mira el estado.');
  }
  if (res.status === 403) throw new Error('Tu usuario no puede cancelar este cobro. Avisa al encargado.');
  if (res.status === 404) throw new Error('Ese cobro ya no existe.');
  throw new Error(
    commonError(res.status) ?? (await readError(res, `No se pudo cancelar el cobro (error ${res.status}).`)),
  );
}

export async function fetchTerminals(): Promise<Array<{ externalId: string; label: string }>> {
  const res = await authedFetch(`/v1/venues/me/terminals`);
  if (res.ok) return (await res.json()) as Array<{ externalId: string; label: string }>;
  throw new Error(commonError(res.status) ?? 'No se pudieron cargar los terminales.');
}
