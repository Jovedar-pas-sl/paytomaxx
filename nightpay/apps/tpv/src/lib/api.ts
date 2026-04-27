// API client TPV — auth via JWT en localStorage (suficiente para uso interno con
// device fingerprint en Sprint 6 endurecemos con magic link).

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';

export const apiBase = API_BASE;
export const wsBase = process.env.NEXT_PUBLIC_WS_URL ?? API_BASE.replace(/^http/, 'ws');

const TOKEN_KEY = 'np_tpv_token';
const VENUE_KEY = 'np_tpv_venue';

export interface LoginResponse {
  accessToken: string;
  expiresIn: number;
  user: { id: string; email: string; role: string; tenantId: string; venueSlug: string };
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

export function getVenueSlug(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(VENUE_KEY);
}

export function setSession(login: LoginResponse): void {
  window.localStorage.setItem(TOKEN_KEY, login.accessToken);
  window.localStorage.setItem(VENUE_KEY, login.user.venueSlug);
}

export function clearSession(): void {
  window.localStorage.removeItem(TOKEN_KEY);
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

export async function createPayment(input: {
  amountCents: number;
  terminalExternalId: string;
}): Promise<CreatedPayment> {
  const token = getToken();
  if (!token) throw new Error('No autenticado');
  const idempotencyKey = crypto.randomUUID();
  const res = await fetch(`${API_BASE}/v1/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(input),
  });
  if (res.status === 401) {
    clearSession();
    throw new Error('Sesión expirada');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function fetchTerminals(): Promise<Array<{ externalId: string; label: string }>> {
  const token = getToken();
  if (!token) throw new Error('No autenticado');
  const res = await fetch(`${API_BASE}/v1/venues/me/terminals`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('No se pudieron cargar terminales');
  return res.json();
}
