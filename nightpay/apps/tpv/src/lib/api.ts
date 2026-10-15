// API client TPV — auth via JWT en localStorage con refresh token rotativo.

import { MESSAGES, commonError, readError, send } from './http';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';

export const apiBase = API_BASE;
export const wsBase = process.env.NEXT_PUBLIC_WS_URL ?? API_BASE.replace(/^http/, 'ws');

const TOKEN_KEY = 'np_tpv_token';
const REFRESH_KEY = 'np_tpv_refresh';
const VENUE_KEY = 'np_tpv_venue';

/** Salir no hace esperar: si el API no contesta en 5 s, la sesión ya se cerró aquí. */
const LOGOUT_TIMEOUT_MS = 5_000;

/** Se lanza en window cuando la sesión muere (el API rechaza el refresh): la página vuelve al login. */
export const SESSION_EXPIRED_EVENT = 'np:session-expired';

export interface LoginResponse {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresIn: number;
  user: { id: string; email: string; role: string; tenantId: string; venueSlug: string };
}

export interface RefreshResponse {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresIn: number;
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

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(REFRESH_KEY);
}

export function getVenueSlug(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(VENUE_KEY);
}

export function setSession(login: LoginResponse): void {
  window.localStorage.setItem(TOKEN_KEY, login.accessToken);
  window.localStorage.setItem(REFRESH_KEY, login.refreshToken);
  window.localStorage.setItem(VENUE_KEY, login.user.venueSlug);
}

function updateTokens(refreshed: RefreshResponse): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(TOKEN_KEY, refreshed.accessToken);
  window.localStorage.setItem(REFRESH_KEY, refreshed.refreshToken);
}

export function clearSession(): void {
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(REFRESH_KEY);
  window.localStorage.removeItem(VENUE_KEY);
}

/** Sesión muerta: se borra, se avisa a la página (vuelve al login) y se devuelve el error a lanzar. */
function expireSession(): Error {
  clearSession();
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  return new Error(MESSAGES.session);
}

export async function login(email: string, password: string): Promise<LoginResponse> {
  const res = await send(`${API_BASE}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (res.ok) return (await res.json()) as LoginResponse;
  if (res.status === 401) {
    // El bloqueo por intentos también llega como 401 ("Too many attempts…").
    const detail = await readError(res, '');
    if (/too many/i.test(detail)) throw new Error(MESSAGES.tooMany);
    if (/disabled/i.test(detail)) throw new Error('Este usuario está desactivado. Habla con el encargado.');
    throw new Error('Email o contraseña incorrectos.');
  }
  if (res.status === 400) throw new Error('Revisa el email y la contraseña.');
  if (res.status === 429) throw new Error(MESSAGES.tooMany);
  throw new Error(MESSAGES.network);
}

/**
 * Cierra la sesión en este equipo siempre. Devuelve si el API anuló también el
 * refresh token (si no, caduca solo). Con el access caducado se manda solo
 * { refreshToken }, que el API acepta.
 */
export async function logout(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  const accessToken = getToken();
  clearSession();
  if (!refreshToken) return true;
  const body = JSON.stringify({ refreshToken });
  try {
    const res = await sendLogout(body, accessToken);
    if (res.status === 401 && accessToken) return (await sendLogout(body, null)).ok;
    return res.ok;
  } catch {
    // Sin red: aquí ya no queda sesión; la página avisa de que el servidor no se enteró.
    return false;
  }
}

function sendLogout(body: string, accessToken: string | null): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return send(`${API_BASE}/v1/auth/logout`, { method: 'POST', headers, body }, LOGOUT_TIMEOUT_MS);
}

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
  if (!refreshToken) throw expireSession();
  const res = await send(`${API_BASE}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) {
    const after = getToken();
    if (after && after !== failed) return after;
    // Solo un "no" del API cierra la sesión; un 429 o un 5xx (p. ej. mientras
    // se despliega) no echa a nadie: el cobro se puede reintentar.
    if (res.status === 401 || res.status === 403) throw expireSession();
    throw new Error(commonError(res.status) ?? MESSAGES.network);
  }
  const refreshed = (await res.json()) as RefreshResponse;
  updateTokens(refreshed);
  return refreshed.accessToken;
}

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  if (!token) throw expireSession();
  const res = await doFetch(path, init, token);
  if (res.status !== 401) return res;
  const newToken = await refreshAccessToken(token);
  const retry = await doFetch(path, init, newToken);
  if (retry.status === 401) throw expireSession();
  return retry;
}

function doFetch(path: string, init: RequestInit, token: string): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return send(`${API_BASE}${path}`, { ...init, headers });
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
