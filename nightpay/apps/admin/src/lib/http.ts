// Cliente del API del panel: un envoltorio fino de @nightpay/api-client (el
// mismo que usan la app de la chica y el TPV) con los nombres de siempre. El
// refresh token va en una cookie HttpOnly del API; el access token, solo en
// la memoria de la pestaña. Los endpoints van en lib/endpoints/.

import {
  ServerUnavailableError,
  SESSION_EXPIRED_EVENT,
  TotpError,
  createApiClient,
  readApiError,
  tokenClaims,
  type CallOptions,
  type LoginResult,
} from '@nightpay/api-client';
import { ApiError, genericStatusMessage, humanizeTotpError, loginErrorMessage, NETWORK_ERROR_MESSAGE } from './api-errors';
import { classifySessionEvent, type SessionChange } from './session-sync';

export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';

export interface User {
  id: string;
  email: string;
  role: 'OWNER' | 'MANAGER' | 'WAITER' | 'OPERATOR';
  tenantId: string;
  venueSlug: string;
  isSuperAdmin?: boolean;
}

/** Lo que devuelve el login: el access token (solo para la memoria) y quién es. El refresh va en la cookie. */
export type LoginResponse = LoginResult<User>;

export interface RefreshResponse {
  accessToken: string;
  expiresIn: number;
  refreshExpiresIn?: number;
}

const SESSION_RENEW_FAILED = 'No se pudo renovar la sesión. Revisa la conexión y vuelve a probar.';

const client = createApiClient<User>({
  baseUrl: API_BASE,
  storagePrefix: 'np_admin',
  messages: {
    sessionExpired: 'Sesión expirada',
    network: NETWORK_ERROR_MESSAGE,
    renewFailed: SESSION_RENEW_FAILED,
  },
  afterRefresh: keepSelectedVenue,
});

/**
 * Evento de `window`: la sesión ha muerto (el refresh ya no vale). La página
 * vuelve al login; antes se quedaba el panel con "Sesión expirada" en rojo.
 */
export { SESSION_EXPIRED_EVENT };

// ─── Sesión ────────────────────────────────────────────────────────

/** El access token de esta pestaña (solo en memoria; null hasta el primer uso). */
export function getToken(): string | null {
  return client.getAccessToken();
}

/** ¿Hay sesión en este navegador? (la cookie dirá si sigue viva al primer uso). */
export function hasSession(): boolean {
  return client.hasSession();
}

/** Quién es la sesión guardada (no secreto: para pintar el panel). */
export function getUser(): User | null {
  return client.getUser();
}

export function setSession(login: LoginResponse): void {
  client.setSession(login);
}

export function clearSession(): void {
  client.clearSession();
}

/**
 * Lo que pasa con la sesión en otras pestañas (salir, entrar, cambiar de
 * local). Devuelve la función para dejar de escuchar.
 */
export function watchSessionFromOtherTabs(onChange: (change: SessionChange) => void): () => void {
  return client.onSessionEvent((event) => {
    const change = classifySessionEvent(event);
    if (change) onChange(change);
  });
}

export async function login(email: string, password: string): Promise<LoginResponse> {
  try {
    return await client.login({ email, password });
  } catch (err) {
    if (err instanceof ServerUnavailableError) throw new ApiError(err.message, 0);
    if (err instanceof ApiError) throw new ApiError(loginErrorMessage(err.status, err.message), err.status);
    throw err;
  }
}

/**
 * Un login que no se va a usar (cuenta sin acceso al panel): se cierra en el
 * API (y se borra la cookie que puso) para no dejar una sesión viva.
 */
export async function discardLogin(_session: LoginResponse): Promise<void> {
  await client.discardLogin();
}

/**
 * Cierra la sesión: aquí se borra siempre (y las otras pestañas salen
 * también); el API la cierra con la cookie aunque el access haya caducado.
 * Devuelve si el API confirmó el cierre.
 */
export function logout(): Promise<boolean> {
  return client.logout();
}

// ─── Cambio de local (super-admin) ────────────────────────────────

export async function switchTenant(
  tenantId: string,
): Promise<{ accessToken: string; expiresIn: number; tenantId: string; venueSlug: string }> {
  const res = await authedFetch('/v1/auth/switch-tenant', {
    method: 'POST',
    body: JSON.stringify({ tenantId }),
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/**
 * Tras cambiar de local (super-admin): token nuevo en esta pestaña y local
 * nuevo en la sesión guardada. Las otras pestañas se enteran y se recargan.
 */
export function applySwitchedTenant(switched: { accessToken: string; tenantId: string; venueSlug: string }): void {
  client.setAccessToken(switched.accessToken);
  const user = getUser();
  if (user) client.updateUser({ ...user, tenantId: switched.tenantId, venueSlug: switched.venueSlug });
}

/** Cambia el local activo del super-admin. Quien llama recarga la página después. */
export async function switchToVenue(tenantId: string): Promise<void> {
  applySwitchedTenant(await switchTenant(tenantId));
}

/**
 * El refresh da el token del local de siempre. El super-admin que había
 * elegido otro local lo recupera aquí, sin recargar la página; si no se
 * puede, se vuelve a su local (syncVenueFromToken).
 */
async function keepSelectedVenue(accessToken: string): Promise<string> {
  const user = getUser();
  const venue = tokenClaims(accessToken)?.tenantId ?? null;
  if (!user || !venue || venue === user.tenantId) return accessToken;
  if (user.isSuperAdmin) {
    try {
      const res = await client.fetchWithToken(
        '/v1/auth/switch-tenant',
        { method: 'POST', body: JSON.stringify({ tenantId: user.tenantId }) },
        accessToken,
      );
      if (res.ok) {
        const switched = (await res.json()) as { accessToken: string };
        client.setAccessToken(switched.accessToken);
        return switched.accessToken;
      }
    } catch {
      // Abajo: se vuelve a su local.
    }
  }
  syncVenueFromToken(accessToken);
  return accessToken;
}

/**
 * El token vale para otro local que el que enseña la pantalla: se corrige y
 * se recarga para no operar en el que no es.
 */
function syncVenueFromToken(accessToken: string): void {
  const claims = tokenClaims(accessToken);
  const user = getUser();
  if (!claims?.tenantId || !user || claims.tenantId === user.tenantId) return;
  client.updateUser({ ...user, tenantId: claims.tenantId, venueSlug: claims.venueSlug ?? user.venueSlug });
  if (typeof window !== 'undefined') window.location.reload();
}

// ─── Helpers ───────────────────────────────────────────────────────

/** Error del API (ProblemDetails: detail / title) con su código HTTP; con código TOTP_*, TotpError. */
export function apiError(res: Response): Promise<ApiError> {
  return readApiError(res, genericStatusMessage);
}

/** Igual, con los errores de 2FA (que el API da en inglés) en castellano. */
export async function totpAwareError(res: Response): Promise<ApiError> {
  const err = await apiError(res);
  const message = humanizeTotpError(err.message, err.code);
  return err instanceof TotpError ? new TotpError(message, err.status, err.code) : new ApiError(message, err.status, err.code);
}

/**
 * Fetch autenticado: pide el access token con la cookie si esta pestaña aún
 * no lo tiene y, con un 401, renueva una vez y repite. Si la sesión ya no
 * vale, se borra y se avisa (SESSION_EXPIRED_EVENT) para volver al login; si
 * el API no respondió al refresh, la sesión sigue ("No se pudo renovar la
 * sesión…") y se reintenta luego. Tiempo máximo 15 s (otro con `opts`).
 */
export function authedFetch(path: string, init: RequestInit = {}, opts?: CallOptions): Promise<Response> {
  return client.authedFetch(path, init, opts);
}
