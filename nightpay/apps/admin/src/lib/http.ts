// Cliente del API del panel: sesión (JWT en localStorage, mismo flujo que TPV),
// renovación del token y fetch autenticado. Los endpoints van en lib/endpoints/.

import {
  ApiError,
  NETWORK_ERROR_MESSAGE,
  errorFromBody,
  humanizeTotpError,
  loginErrorMessage,
} from './api-errors';
import { classifySessionChange, type SessionChange } from './session-sync';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';

const TOKEN_KEY = 'np_admin_token';
const REFRESH_KEY = 'np_admin_refresh';
const USER_KEY = 'np_admin_user';

export interface User {
  id: string;
  email: string;
  role: 'OWNER' | 'MANAGER' | 'WAITER' | 'OPERATOR';
  tenantId: string;
  venueSlug: string;
  isSuperAdmin?: boolean;
}

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
 * Tras cambiar de local (super-admin): token nuevo y local nuevo en la sesión
 * guardada. Las otras pestañas lo ven por el evento `storage` y se recargan.
 */
export function applySwitchedTenant(switched: { accessToken: string; tenantId: string; venueSlug: string }): void {
  const user = getUser();
  window.localStorage.setItem(TOKEN_KEY, switched.accessToken);
  if (user) {
    window.localStorage.setItem(
      USER_KEY,
      JSON.stringify({ ...user, tenantId: switched.tenantId, venueSlug: switched.venueSlug }),
    );
  }
}

/** Cambia el local activo del super-admin. Quien llama recarga la página después. */
export async function switchToVenue(tenantId: string): Promise<void> {
  applySwitchedTenant(await switchTenant(tenantId));
}

export interface LoginResponse {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresIn: number;
  user: User;
}

export interface RefreshResponse {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresIn: number;
}

// ─── Auth ──────────────────────────────────────────────────────────

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(REFRESH_KEY);
}

export function getUser(): User | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

export function setSession(login: LoginResponse): void {
  window.localStorage.setItem(TOKEN_KEY, login.accessToken);
  window.localStorage.setItem(REFRESH_KEY, login.refreshToken);
  window.localStorage.setItem(USER_KEY, JSON.stringify(login.user));
}

/**
 * Tras refrescar, el token vale para el local principal del usuario (el
 * cambio de local del superadmin no sobrevive al refresco). Si la pantalla
 * enseñaba otro local, se corrige y se recarga para no operar en el que no es.
 */
/** Local (tenantId) y slug que lleva un token; null si no se puede leer. */
function claimsOfToken(accessToken: string): { tenantId?: string; venueSlug?: string } | null {
  try {
    const part = accessToken.split('.')[1] ?? '';
    return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as {
      tenantId?: string;
      venueSlug?: string;
    };
  } catch {
    return null;
  }
}

function venueOfToken(accessToken: string): string | null {
  return claimsOfToken(accessToken)?.tenantId ?? null;
}

function syncVenueFromToken(accessToken: string): void {
  if (typeof window === 'undefined') return;
  try {
    const claims = claimsOfToken(accessToken);
    if (!claims) return;
    const user = getUser();
    if (!user || !claims.tenantId || claims.tenantId === user.tenantId) return;
    window.localStorage.setItem(
      USER_KEY,
      JSON.stringify({ ...user, tenantId: claims.tenantId, venueSlug: claims.venueSlug ?? user.venueSlug }),
    );
    window.location.reload();
  } catch {
    // Token ilegible: se deja como estaba.
  }
}

function updateTokens(refreshed: RefreshResponse): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(TOKEN_KEY, refreshed.accessToken);
  window.localStorage.setItem(REFRESH_KEY, refreshed.refreshToken);
}

export function clearSession(): void {
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(REFRESH_KEY);
  window.localStorage.removeItem(USER_KEY);
}

/**
 * Evento de `window`: la sesión ha muerto (el refresh ya no vale). La página
 * vuelve al login; antes se quedaba el panel con "Sesión expirada" en rojo.
 */
export const SESSION_EXPIRED_EVENT = 'np:session-expired';

/** Mientras se sale a propósito, una sesión que ya estaba caducada no es "caducada". */
let loggingOut = false;

function expireSession(): void {
  clearSession();
  if (!loggingOut && typeof window !== 'undefined') {
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  }
}

/**
 * Lo que pasa con la sesión en otras pestañas (salir, entrar, cambiar de
 * local). Devuelve la función para dejar de escuchar.
 */
export function watchSessionFromOtherTabs(onChange: (change: SessionChange) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  function onStorage(e: StorageEvent): void {
    if (e.storageArea !== window.localStorage) return;
    const change = classifySessionChange(e.key, e.oldValue, e.newValue, { token: TOKEN_KEY, user: USER_KEY });
    if (change) onChange(change);
  }
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}

export async function login(email: string, password: string): Promise<LoginResponse> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    throw new ApiError(NETWORK_ERROR_MESSAGE, 0);
  }
  if (!res.ok) {
    const { message } = errorFromBody(await res.text().catch(() => ''), res.status);
    throw new ApiError(loginErrorMessage(res.status, message), res.status);
  }
  return res.json();
}

function postLogout(refreshToken: string, accessToken: string | null): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return fetch(`${API_BASE}/v1/auth/logout`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ refreshToken }),
  });
}

/**
 * Un login que no se va a usar (cuenta sin acceso al panel): se revoca en el
 * API para no dejar una sesión viva. Es limpieza: si falla, caduca sola.
 */
export async function discardLogin(session: LoginResponse): Promise<void> {
  try {
    await postLogout(session.refreshToken, session.accessToken);
  } catch {
    // Sin red: el refresh caduca solo y aquí no se guardó nada.
  }
}

/**
 * Cierra la sesión. El refresh token se manda aunque el access haya caducado
 * (el API lo revoca solo con él); si el API aún pide un access válido (401),
 * se renueva una vez y se repite con el refresh nuevo. La sesión local se
 * borra siempre. Devuelve si el API confirmó el cierre.
 */
export async function logout(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  let confirmed = refreshToken === null; // nada que revocar
  loggingOut = true;
  try {
    if (refreshToken) {
      let res = await postLogout(refreshToken, getToken());
      if (res.status === 401) {
        const access = await refreshAccessToken(getToken()).catch(() => null);
        const rotated = getRefreshToken();
        if (access && rotated) res = await postLogout(rotated, access);
      }
      confirmed = res.ok;
    }
  } catch {
    confirmed = false;
  } finally {
    loggingOut = false;
    clearSession();
  }
  return confirmed;
}

/**
 * Cambia el refresh token por un access token nuevo.
 * Devuelve el nuevo access token y rota el refresh.
 * Si el refresh es invalido (caducado, reusado, revocado), limpia la sesion y lanza.
 */
/**
 * Un solo refresco a la vez: si varias peticiones caducan juntas y cada una
 * refresca, el API ve el mismo refresh token dos veces, lo toma por robado y
 * cierra la sesión (la chica se queda fuera en mitad de un cobro).
 */
let refreshing: Promise<string> | null = null;
function refreshAccessToken(failed: string | null = getToken()): Promise<string> {
  refreshing ??= withRefreshLock(() => doRefreshAccessToken(failed)).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/**
 * Las pestañas abiertas comparten la sesión (localStorage): el refresco va de
 * una en una también entre pestañas (Web Locks; sin ellos, como antes).
 */
function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return locks ? (locks.request(`${REFRESH_KEY}:lock`, fn) as Promise<T>) : fn();
}

async function doRefreshAccessToken(failed: string | null): Promise<string> {
  // Otra pestaña ya lo renovó mientras esperábamos: vale el suyo.
  const current = getToken();
  if (current && current !== failed) return current;
  const refreshToken = getRefreshToken();
  if (!refreshToken) {
    expireSession();
    throw new Error('Sesión expirada');
  }
  const res = await fetch(`${API_BASE}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) {
    const after = getToken();
    if (after && after !== failed) return after;
    // Solo un "no" del API cierra la sesión; un 429 o un 5xx (p. ej. mientras
    // se despliega) no echa a nadie.
    if (res.status === 401 || res.status === 403) {
      expireSession();
      throw new Error('Sesión expirada');
    }
    throw new Error(SESSION_RENEW_FAILED);
  }
  const refreshed = (await res.json()) as RefreshResponse;
  updateTokens(refreshed);
  return keepSelectedVenue(refreshed.accessToken);
}

/**
 * El refresh da el token del local de siempre. El super-admin que había
 * elegido otro local lo recupera aquí, sin recargar la página; si no se
 * puede, se vuelve a su local (syncVenueFromToken).
 */
async function keepSelectedVenue(accessToken: string): Promise<string> {
  const user = getUser();
  const venue = venueOfToken(accessToken);
  if (!user || !venue || venue === user.tenantId) return accessToken;
  if (user.isSuperAdmin) {
    try {
      const res = await doFetch(
        '/v1/auth/switch-tenant',
        { method: 'POST', body: JSON.stringify({ tenantId: user.tenantId }) },
        accessToken,
      );
      if (res.ok) {
        const switched = (await res.json()) as { accessToken: string };
        window.localStorage.setItem(TOKEN_KEY, switched.accessToken);
        return switched.accessToken;
      }
    } catch {
      // Abajo: se vuelve a su local.
    }
  }
  syncVenueFromToken(accessToken);
  return accessToken;
}

// ─── Helpers ───────────────────────────────────────────────────────

/** Error del API (ProblemDetails: detail / title) con su código HTTP. */
export async function apiError(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => '');
  const { message, code } = errorFromBody(text, res.status);
  return new ApiError(message, res.status, code);
}

/** Igual, con los errores de 2FA (que el API da en inglés) en castellano. */
export async function totpAwareError(res: Response): Promise<ApiError> {
  const err = await apiError(res);
  return new ApiError(humanizeTotpError(err.message, err.code), err.status, err.code);
}

const SESSION_RENEW_FAILED = 'No se pudo renovar la sesión. Revisa la conexión y vuelve a probar.';

/**
 * Fetch autenticado con auto-refresh en 401:
 *   1. Intenta con el access token actual
 *   2. Si recibe 401 y tenemos refresh token, intercambia y reintenta UNA vez
 *   3. Si el refresh ya no vale (o el reintento da 401), la sesión muere:
 *      se borra y se avisa (SESSION_EXPIRED_EVENT) para volver al login.
 *      Si el API no respondió al refresh, la sesión sigue y se reintenta luego.
 */
export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  if (!token) {
    expireSession();
    throw new Error('Sesión expirada');
  }
  const res = await doFetch(path, init, token);
  if (res.status !== 401) return res;

  // 401 — probar refresh una vez
  let newToken: string;
  try {
    newToken = await refreshAccessToken(token);
  } catch (err) {
    throw new Error(getRefreshToken() ? SESSION_RENEW_FAILED : (err as Error).message || 'Sesión expirada');
  }
  const retry = await doFetch(path, init, newToken);
  if (retry.status === 401) {
    expireSession();
    throw new Error('Sesión expirada');
  }
  return retry;
}

async function doFetch(path: string, init: RequestInit, token: string): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  try {
    return await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    // "Failed to fetch" en inglés no le dice nada a nadie.
    throw new ApiError(NETWORK_ERROR_MESSAGE, 0);
  }
}
