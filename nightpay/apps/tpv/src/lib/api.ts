// API client TPV — auth via JWT en localStorage con refresh token rotativo.

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';

export const apiBase = API_BASE;
export const wsBase = process.env.NEXT_PUBLIC_WS_URL ?? API_BASE.replace(/^http/, 'ws');

const TOKEN_KEY = 'np_tpv_token';
const REFRESH_KEY = 'np_tpv_refresh';
const VENUE_KEY = 'np_tpv_venue';

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

export async function login(email: string, password: string): Promise<LoginResponse> {
  const res = await fetch(`${API_BASE}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error('Credenciales inválidas');
  return res.json();
}

export async function logout(): Promise<void> {
  const refreshToken = getRefreshToken();
  const accessToken = getToken();
  if (refreshToken && accessToken) {
    try {
      await fetch(`${API_BASE}/v1/auth/logout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ refreshToken }),
      });
    } catch {
      // Best-effort
    }
  }
  clearSession();
}

async function refreshAccessToken(): Promise<string> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) {
    clearSession();
    throw new Error('Sesión expirada');
  }
  const res = await fetch(`${API_BASE}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) {
    clearSession();
    throw new Error('Sesión expirada');
  }
  const refreshed = (await res.json()) as RefreshResponse;
  updateTokens(refreshed);
  return refreshed.accessToken;
}

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  if (!token) throw new Error('No autenticado');
  const res = await doFetch(path, init, token);
  if (res.status !== 401) return res;
  let newToken: string;
  try {
    newToken = await refreshAccessToken();
  } catch {
    throw new Error('Sesión expirada');
  }
  const retry = await doFetch(path, init, newToken);
  if (retry.status === 401) {
    clearSession();
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
  return fetch(`${API_BASE}${path}`, { ...init, headers });
}

export async function createPayment(input: {
  amountCents: number;
  terminalExternalId: string;
}): Promise<CreatedPayment> {
  const idempotencyKey = crypto.randomUUID();
  const res = await authedFetch(`/v1/payments`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function fetchTerminals(): Promise<Array<{ externalId: string; label: string }>> {
  const res = await authedFetch(`/v1/venues/me/terminals`);
  if (!res.ok) throw new Error('No se pudieron cargar terminales');
  return res.json();
}
