// Operator app API client (mobile-first PWA).
// Sesion JWT en localStorage, igual patrón que TPV/Admin.

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';

const TOKEN_KEY = 'np_op_token';
const REFRESH_KEY = 'np_op_refresh';
const USER_KEY = 'np_op_user';

// ─── Errores ──────────────────────────────────────────────────────

/** La sesión se acabó de verdad: la app (page.tsx) lo escucha y vuelve al login. */
export const SESSION_EXPIRED_EVENT = 'np:session-expired';

const SESSION_EXPIRED_TEXT = 'Tu sesión ha caducado. Vuelve a iniciar sesión.';
const SERVER_DOWN_TEXT = 'El servidor está teniendo problemas. Vuelve a intentarlo en unos segundos.';
const NO_CONNECTION_TEXT = 'No se pudo conectar con el servidor. Comprueba la conexión y vuelve a intentarlo.';
const TOO_MANY_TEXT = 'Demasiados intentos. Espera un momento.';

/** El API dijo que no (refresh rechazado) o ya no hay sesión: hay que volver a entrar. */
export class SessionExpiredError extends Error {
  constructor() {
    super(SESSION_EXPIRED_TEXT);
    this.name = 'SessionExpiredError';
  }
}

/** Sin red, servidor caído o saturado (5xx, 429): la sesión sigue y se reintenta. */
export class ServerUnavailableError extends Error {
  constructor(message = NO_CONNECTION_TEXT) {
    super(message);
    this.name = 'ServerUnavailableError';
  }
}

/** Lo que enseña una pantalla que se refresca sola cuando falla una vuelta. */
export function pollErrorText(err: unknown): string {
  if (err instanceof ServerUnavailableError) return 'Servidor no disponible, reintentando…';
  return err instanceof Error ? err.message : 'Algo ha fallado.';
}

const isTransientStatus = (status: number): boolean => status === 429 || status >= 500;

/** Una carga que falla: si el servidor está caído o saturado, se dice así (se reintenta sola). */
function loadError(res: Response, message: string): Error {
  return isTransientStatus(res.status) ? new ServerUnavailableError(SERVER_DOWN_TEXT) : new Error(message);
}

/**
 * Convierte error HTTP en mensaje legible para la chica en un club ruidoso.
 * Lee el `detail` del backend (Problem Details RFC 7807).
 */
export async function parseOperatorApiError(res: Response, context: string): Promise<string> {
  return operatorErrorMessage(res.status, await readBackendDetail(res), context);
}

async function readBackendDetail(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    if (text.startsWith('{')) {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const value = parsed.userMessage ?? parsed.detail ?? parsed.message ?? parsed.title;
      return typeof value === 'string' ? value : undefined;
    }
    return text && text.length < 100 ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Error HTTP → frase concreta. El texto del servidor se enseña cuando es
 * corto y no técnico: los 403/409/422 de negocio dicen qué pasa ("El máximo
 * que puedes cobrar de una vez es 300 €", "Este PIN lo pusiste tú…").
 * NO devolvemos JSON crudo, stack, ni códigos técnicos.
 */
export function operatorErrorMessage(status: number, backendDetail: string | undefined, context: string): string {
  const detail = shownDetail(backendDetail);
  if (status === 401) return SESSION_EXPIRED_TEXT;
  if (status === 403) return detail ?? 'No tienes permiso para esta acción.';
  if (status === 404) return `${context} no encontrado.`;
  if (status === 409) {
    return detail && detail.length < 120 ? detail : 'Esta operación ya está en curso o no se puede repetir.';
  }
  if (status === 422) return detail ?? 'Los datos enviados no son válidos.';
  if (status === 429) return TOO_MANY_TEXT;
  if (status >= 500) return SERVER_DOWN_TEXT;
  return detail ?? `${context} no se pudo completar.`;
}

/** Textos técnicos del API (guardas de rol, títulos HTTP): no se enseñan tal cual. */
const TECHNICAL_DETAIL =
  /\bnot allowed\b|\brequires one of\b|^authentication required$|^(bad request|unauthorized|forbidden|forbidden resource|not found|conflict|gone|unprocessable entity|too many requests|internal server error|service unavailable)$/i;

function shownDetail(detail: string | undefined): string | undefined {
  const text = detail?.trim();
  if (!text || text.length >= 200 || TECHNICAL_DETAIL.test(text)) return undefined;
  return text;
}

/** Por qué no se pudo entrar (null = sin respuesta: sin red). */
export function loginErrorMessage(status: number | null, detail?: string): string {
  if (status === null || status >= 500) return 'No se pudo conectar con el servidor. Inténtalo de nuevo.';
  // El bloqueo por fallos llega como 401 "Too many attempts" o como 429.
  if (status === 429 || /too many/i.test(detail ?? '')) {
    return 'Demasiados intentos. Espera unos minutos y vuelve a probar.';
  }
  if (status === 400 || status === 401 || status === 422) return 'Email o contraseña incorrectos.';
  return 'No se pudo entrar. Inténtalo de nuevo.';
}

export interface OperatorUser {
  id: string;
  email: string;
  role: 'OWNER' | 'MANAGER' | 'WAITER' | 'OPERATOR';
  tenantId: string;
  venueSlug: string;
  displayName?: string | null;
}

export interface LoginResponse {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresIn: number;
  user: OperatorUser;
}

export interface RefreshResponse {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresIn: number;
}

export interface OperatorBalance {
  pendingCents: number;
  /** Entra en el próximo pago (pasados los días de espera). */
  availableCents?: number;
  /** Comisiones recientes aún en espera. */
  heldCents?: number;
  /** Devoluciones llegadas después de un pago, a descontar. */
  debtCents?: number;
  paidCents: number;
  lifetimeGrossCents: number;
  count: number;
}

export interface MyEarning {
  id: string;
  paymentId: string;
  paymentAmountCents: number;
  commissionBps: number;
  commissionCents: number;
  reversedCents: number;
  netCents: number;
  payoutId: string | null;
  paymentStatus: string;
  createdAt: string;
}

export interface MyPayment {
  id: string;
  amountCents: number;
  currency: string;
  status: string;
  provider: string | null;
  createdAt: string;
  qrToken: string;
  qrExpiresAt: string;
}

export interface MyPayout {
  id: string;
  totalCents: number;
  paidByEmail: string | null;
  notes: string | null;
  earningCount: number;
  createdAt: string;
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
  // Phase 1B — set cuando el cobro es un top-up de wallet
  walletId?: string | null;
}

// ─── Token storage ────────────────────────────────────────────────

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}
export function getRefreshToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(REFRESH_KEY);
}
export function getUser(): OperatorUser | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OperatorUser;
  } catch {
    return null;
  }
}
export function setSession(login: LoginResponse): void {
  window.localStorage.setItem(TOKEN_KEY, login.accessToken);
  window.localStorage.setItem(REFRESH_KEY, login.refreshToken);
  window.localStorage.setItem(USER_KEY, JSON.stringify(login.user));
}
export function clearSession(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(REFRESH_KEY);
  window.localStorage.removeItem(USER_KEY);
}

/** La sesión se acabó: se borra y la app vuelve al login (evento para page.tsx). */
function endSession(): SessionExpiredError {
  clearSession();
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  }
  return new SessionExpiredError();
}

/**
 * Avisa cuando la sesión se acaba: caducada aquí (evento) o cerrada en otra
 * pestaña (comparten localStorage). Devuelve cómo dejar de escuchar.
 */
export function onSessionEnded(handler: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if ((e.key === null || e.key === TOKEN_KEY) && !getToken()) handler();
  };
  window.addEventListener(SESSION_EXPIRED_EVENT, handler);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(SESSION_EXPIRED_EVENT, handler);
    window.removeEventListener('storage', onStorage);
  };
}

// ─── Auth ─────────────────────────────────────────────────────────

export async function login(email: string, password: string): Promise<LoginResponse> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    throw new Error(loginErrorMessage(null));
  }
  if (!res.ok) throw new Error(loginErrorMessage(res.status, await readBackendDetail(res)));
  return res.json();
}

/**
 * Salir: la sesión local se cierra al momento (sin esperar a la red) y la del
 * servidor con el refresh token, aunque el access token ya haya caducado.
 */
export async function logout(): Promise<void> {
  const refreshToken = getRefreshToken();
  const accessToken = getToken();
  clearSession();
  if (refreshToken) await revokeSession(refreshToken, accessToken);
}

/** Nunca falla: sin red, el refresh token caduca solo (y aquí ya no está). */
async function revokeSession(refreshToken: string, accessToken: string | null): Promise<void> {
  try {
    const res = await postLogout(refreshToken, accessToken);
    if (res.status !== 401) return;
    // Un API que aún pide un access token vigente: se saca uno con el refresh
    // (sin guardarlo) y se cierra con él.
    const refreshed = await fetch(`${API_BASE}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!refreshed.ok) return; // ya no valía: no queda nada que cerrar
    const pair = (await refreshed.json()) as RefreshResponse;
    await postLogout(pair.refreshToken, pair.accessToken);
  } catch {
    // Sin red: la sesión local ya está cerrada.
  }
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
  if (!refreshToken) throw endSession();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
  } catch {
    throw new ServerUnavailableError();
  }
  if (!res.ok) {
    const after = getToken();
    if (after && after !== failed) return after;
    // Solo un "no" del API cierra la sesión; un 429 o un 5xx (p. ej. mientras
    // se despliega) no echa a nadie.
    if (res.status === 400 || res.status === 401 || res.status === 403) throw endSession();
    throw new ServerUnavailableError(SERVER_DOWN_TEXT);
  }
  const refreshed = (await res.json()) as RefreshResponse;
  window.localStorage.setItem(TOKEN_KEY, refreshed.accessToken);
  window.localStorage.setItem(REFRESH_KEY, refreshed.refreshToken);
  return refreshed.accessToken;
}

/**
 * ¿El JWT caduca en menos de `marginMs`? Si no se puede leer, se da por
 * bueno (ya lo dirá el servidor).
 */
export function tokenExpiresSoon(token: string, now = Date.now(), marginMs = 60_000): boolean {
  const payload = token.split('.')[1];
  if (!payload) return false;
  try {
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: unknown };
    return typeof claims.exp === 'number' && claims.exp * 1000 - now < marginMs;
  } catch {
    return false;
  }
}

/**
 * El access token para el socket en tiempo real (se manda al conectar y al
 * reconectar): si está a punto de caducar, se renueva antes.
 */
export async function freshAccessToken(): Promise<string | null> {
  const token = getToken();
  if (!token || !tokenExpiresSoon(token)) return token;
  try {
    return await refreshAccessToken(token);
  } catch {
    return getToken();
  }
}

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  if (!token) throw endSession();
  const res = await doFetch(path, init, token);
  if (res.status !== 401) return res;
  // Caducada de verdad → SessionExpiredError; servidor caído → ServerUnavailableError.
  const newToken = await refreshAccessToken(token);
  const retry = await doFetch(path, init, newToken);
  if (retry.status === 401) throw endSession();
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
    // Cancelada a propósito (AbortController): no es que el servidor no conteste.
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new ServerUnavailableError();
  }
}

// ─── Endpoints ────────────────────────────────────────────────────

export async function fetchBalance(): Promise<OperatorBalance> {
  const res = await authedFetch('/v1/operators/me/balance');
  if (!res.ok) throw loadError(res, 'Error cargando saldo');
  return res.json();
}

/** Fase 1D — la noche en curso de la chica: sus cobros y su parte. */
export interface MyNight {
  from: string;
  /** Cierre de la última noche si ya está cerrada; null si sigue abierta o no hay. */
  to: string | null;
  nightOpen: boolean;
  count: number;
  chargedCents: number;
  commissionCents: number;
  tipsCents: number;
  reversedCents: number;
  netCents: number;
}

export async function fetchMyNight(): Promise<MyNight> {
  const res = await authedFetch('/v1/nights/mine');
  if (!res.ok) throw loadError(res, 'Error cargando tu noche');
  return res.json();
}

export async function fetchMyEarnings(): Promise<MyEarning[]> {
  const res = await authedFetch('/v1/operators/me/earnings');
  if (!res.ok) throw loadError(res, 'Error cargando ganancias');
  return res.json();
}

export async function fetchMyPayments(): Promise<MyPayment[]> {
  const res = await authedFetch('/v1/operators/me/payments');
  if (!res.ok) throw loadError(res, 'Error cargando cobros');
  return res.json();
}

export async function fetchMyPayouts(): Promise<MyPayout[]> {
  const res = await authedFetch('/v1/operators/me/payouts');
  if (!res.ok) throw loadError(res, 'Error cargando liquidaciones');
  return res.json();
}

/**
 * Crea un cobro. La operadora elige importe; backend valida cap del venue.
 * Usa el primer terminal del venue por defecto (la chica no elige terminal).
 */
export async function createPayment(input: {
  amountCents: number;
  /**
   * externalId del terminal específico. Opcional cuando se pasa `zone` —
   * el backend resuelve un terminal cualquiera de esa zona.
   */
  terminalExternalId?: string;
  /** Track A — routing por zona (BARRA, HABITACIONES, MESAS, OTRO/<custom>). */
  zone?: string;
  /** Solo si zone='OTRO' — el nombre real de la zona personalizada. */
  zoneCustom?: string;
  currency?: string;
  /** Phase 1B — si set, crea una wallet etiquetada con identifier. */
  walletIdentifier?: string;
  /** POS — el camarero confirma tras procesar tarjeta en datáfono externo. */
  captureMethod?: 'QR' | 'POS_EXTERNAL';
  /** Categoría contable: CHICA_SERVICE | VENUE_BAR | VENUE_ROOM | VENUE_FOOD | EXTRA */
  revenueCategory?: 'CHICA_SERVICE' | 'VENUE_BAR' | 'VENUE_ROOM' | 'VENUE_FOOD' | 'EXTRA';
  /** Fase 1A — servicio de la carta: el servidor usa su precio y su categoría. */
  serviceItemId?: string;
  /** Una por intento de cobro (la pantalla la reutiliza si se repite). */
  idempotencyKey?: string;
}): Promise<CreatedPayment> {
  const idemKey = input.idempotencyKey ?? newIdempotencyKey();
  const body: Record<string, unknown> = {
    amountCents: input.amountCents,
    currency: input.currency ?? 'EUR',
  };
  if (input.terminalExternalId) body.terminalExternalId = input.terminalExternalId;
  if (input.zone) {
    // Para zona OTRO/<custom> el contract espera zone='OTRO' + zoneCustom='<custom>'.
    if (input.zone.startsWith('OTRO/') && !input.zoneCustom) {
      body.zone = 'OTRO';
      body.zoneCustom = input.zone.slice('OTRO/'.length);
    } else {
      body.zone = input.zone;
      if (input.zoneCustom) body.zoneCustom = input.zoneCustom;
    }
  }
  if (input.walletIdentifier) {
    body.wallet = { create: true, identifier: input.walletIdentifier };
  }
  if (input.captureMethod) {
    body.captureMethod = input.captureMethod;
  }
  if (input.revenueCategory) {
    body.revenueCategory = input.revenueCategory;
  }
  if (input.serviceItemId) {
    body.serviceItemId = input.serviceItemId;
  }
  const res = await authedFetch('/v1/payments', {
    method: 'POST',
    headers: { 'Idempotency-Key': idemKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Cobro'));
  return res.json();
}

// ─── POS pendings (cobros que esperan confirmación del camarero) ──

export interface PendingPosPayment {
  id: string;
  amountCents: number;
  currency: string;
  createdAt: string;
  qrExpiresAt: string;
  createdByName: string;
  qrToken: string;
  refCode: string;
  zone: string | null;
  terminalLabel: string | null;
}

export async function fetchPendingPos(zone?: string): Promise<PendingPosPayment[]> {
  const qs = zone ? `?zone=${encodeURIComponent(zone)}` : '';
  const res = await authedFetch(`/v1/payments/pending-pos${qs}`);
  if (!res.ok) throw loadError(res, 'Error cargando POS pendientes');
  return res.json();
}

export async function confirmPosPayment(
  paymentId: string,
  input: { posReceiptRef: string; posReceiptPhoto?: string; notes?: string },
): Promise<{ status: string }> {
  const res = await authedFetch(`/v1/payments/${paymentId}/confirm-pos`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Confirmación POS'));
  return res.json();
}

export async function cancelPayment(id: string): Promise<{ status: string }> {
  const res = await authedFetch(`/v1/payments/${id}/cancel`, { method: 'POST' });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Cancelación'));
  return res.json();
}

export async function fetchTerminals(): Promise<Array<{ externalId: string; label: string }>> {
  const res = await authedFetch('/v1/venues/me/terminals');
  if (!res.ok) throw loadError(res, 'Error cargando terminales');
  return res.json();
}

// ─── Track A — Zonas ──────────────────────────────────────────────

export interface ZoneOption {
  zone: string; // canonical: 'BARRA', 'HABITACIONES', 'MESAS', 'OTRO/<custom>'
  zoneDisplay: string;
  terminalCount: number;
  activeCount: number;
}

/** Fase 1A — servicio de la carta del local ("30 min · 100 €"). */
export interface ServiceItem {
  id: string;
  name: string;
  durationMin: number | null;
  priceCents: number;
  category: 'CHICA_SERVICE' | 'VENUE_BAR' | 'VENUE_ROOM' | 'VENUE_FOOD' | 'EXTRA';
}

/** Lo que quien llama puede cobrar (la chica solo ve sus servicios). */
export async function fetchServices(): Promise<ServiceItem[]> {
  const res = await authedFetch('/v1/services');
  if (!res.ok) throw loadError(res, 'Error cargando la carta');
  return res.json();
}

export async function fetchZones(): Promise<ZoneOption[]> {
  const res = await authedFetch('/v1/terminals/zones');
  if (!res.ok) throw loadError(res, 'Error cargando zonas');
  return res.json();
}

// ─── Saldo NightPay: cobrar del saldo con confirmación del cliente ───

/** Saldo del cliente encontrado por el código que enseña en su móvil. */
export interface WalletLookup {
  walletId: string;
  code: string;
  balanceCents: number;
  label: string | null;
  homeVenueName: string;
  pendingRequest: boolean;
  /** Puede pagar sin sacar el móvil, con su PIN. */
  hasPin: boolean;
  /** 5 PIN fallidos: hasta que lo desbloquee el encargado. */
  pinLocked: boolean;
  /** Tiene ficha NFC. */
  hasCard: boolean;
}

/** Cómo se dice cuál es el saldo sin el móvil del cliente: su código o su ficha. */
export type WalletRef = { code: string } | { card: string; uid?: string | null };

/** La ficha NFC que acercan → su saldo. */
export async function lookupWalletCard(card: string, uid: string | null): Promise<WalletLookup> {
  const res = await authedFetch('/v1/wallet-charges/cards/lookup', {
    method: 'POST',
    body: JSON.stringify({ card, ...(uid ? { uid } : {}) }),
  });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Ficha'));
  return res.json();
}

/** Código nuevo (lo crea el servidor) para grabar en una ficha vacía. */
export async function issueWalletCard(): Promise<string> {
  const res = await authedFetch('/v1/wallet-charges/cards/new', { method: 'POST' });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Ficha'));
  return ((await res.json()) as { card: string }).card;
}

/** Dar ficha NFC al saldo (justo al recargar). */
export async function linkWalletCard(code: string, card: string, uid: string | null): Promise<WalletLookup> {
  const res = await authedFetch('/v1/wallet-charges/cards', {
    method: 'POST',
    body: JSON.stringify({ code, card, ...(uid ? { uid } : {}) }),
  });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Ficha'));
  return res.json();
}

/** La recarga recién cobrada: su código y si ya tiene PIN. */
export async function fetchWalletById(walletId: string): Promise<WalletLookup> {
  const res = await authedFetch(`/v1/wallet-charges/wallets/${encodeURIComponent(walletId)}/lookup`);
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Saldo'));
  return res.json();
}

/** El cliente elige su PIN en el móvil de la chica (justo tras recargar). */
export async function setWalletPin(code: string, pin: string): Promise<WalletLookup> {
  const res = await authedFetch('/v1/wallet-charges/pin', { method: 'POST', body: JSON.stringify({ code, pin }) });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'PIN del saldo'));
  return res.json();
}

/** El cliente no saca el móvil: paga este cobro con su código (o su ficha) y su PIN. */
export async function payWalletChargeWithPin(id: string, ref: WalletRef, pin: string): Promise<WalletChargeRequest> {
  const res = await authedFetch(`/v1/wallet-charges/${encodeURIComponent(id)}/pin`, {
    method: 'POST',
    body: JSON.stringify({ ...ref, pin }),
  });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'PIN del saldo'));
  return res.json();
}

export type WalletChargeStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'CANCELED';

/** Petición de cobro que el cliente acepta o rechaza en su móvil. */
export interface WalletChargeRequest {
  id: string;
  status: WalletChargeStatus;
  amountCents: number;
  serviceName: string | null;
  expiresAt: string;
  newBalanceCents: number | null;
}

export async function lookupWalletCode(code: string): Promise<WalletLookup> {
  const res = await authedFetch(`/v1/wallet-charges/lookup/${encodeURIComponent(code)}`);
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Código de saldo'));
  return res.json();
}

/** Cobro del saldo con QR: el cliente lo escanea y paga desbloqueando su móvil (Face ID). */
export interface QrWalletCharge extends WalletChargeRequest {
  payToken: string;
  payUrl: string;
  qrPngDataUrl: string;
}

export async function createQrWalletCharge(input: {
  serviceItemId?: string;
  amountCents?: number;
}): Promise<QrWalletCharge> {
  const res = await authedFetch('/v1/wallet-charges/qr', { method: 'POST', body: JSON.stringify(input) });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Cobro del saldo'));
  return res.json();
}

export async function fetchWalletCharge(id: string): Promise<WalletChargeRequest> {
  const res = await authedFetch(`/v1/wallet-charges/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Cobro del saldo'));
  return res.json();
}

export async function cancelWalletCharge(id: string): Promise<void> {
  const res = await authedFetch(`/v1/wallet-charges/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Cancelar cobro'));
}

// ─── Public — Self-onboarding ─────────────────────────────────────

/** Petición sin sesión (enlaces de alta e invitación): sin red, un mensaje claro. */
async function publicFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${API_BASE}${path}`, init);
  } catch {
    throw new ServerUnavailableError();
  }
}

export type WalletProvider =
  | 'BINANCE' | 'BYBIT' | 'OKX' | 'CRYPTO_COM' | 'TRUST_WALLET'
  | 'FASTERPAY' | 'PAYQUICKER' | 'WISE' | 'REVOLUT' | 'OTHER' | 'NONE';

export type WalletStatusKYC =
  | 'NOT_STARTED' | 'REGISTERED' | 'KYC_PENDING' | 'KYC_VERIFIED' | 'KYC_REJECTED';

export type PayoutMethod =
  | 'USDT_TRC20' | 'USDT_BEP20' | 'USDC_POLY' | 'USDC_SOL'
  | 'BINANCE_PAY_ID' | 'OKX_INTERNAL' | 'BYBIT_INTERNAL'
  | 'FASTERPAY_EMAIL' | 'PAYQUICKER_EMAIL' | 'HYPERWALLET_TOKEN'
  | 'REVOLUT_TAG' | 'PAYONEER_EMAIL'
  | 'SEPA_IBAN' | 'WIRE_INTERNATIONAL'
  | 'MERCADOPAGO_CVU' | 'PIX_KEY' | 'NEQUI_PHONE' | 'DAVIPLATA_PHONE'
  | 'MANUAL_CASH';

export interface SelfOnboardingProfile {
  displayName: string | null;
  email: string;
  phone: string | null;
  passportCountry: string | null;
  passportLast4: string | null;
  hasEmpadronamiento: boolean;
  hasNie: boolean;
  hasTie: boolean;
  walletProvider: WalletProvider | null;
  walletStatus: WalletStatusKYC | null;
  walletTestPassed: boolean;
  needsHelpWallet: boolean;
  needsHelpDocs: boolean;
  onboardingNotes: string | null;
  payoutMethod: PayoutMethod | null;
  payoutAddress: string | null;
  payoutLabel: string | null;
  venueName: string;
}

export interface SelfOnboardingSubmitDto {
  phone?: string | null;
  passportCountry?: string | null;
  passportLast4?: string | null;
  hasEmpadronamiento?: boolean;
  hasNie?: boolean;
  hasTie?: boolean;
  walletProvider?: WalletProvider | null;
  walletStatus?: WalletStatusKYC | null;
  walletTestPassed?: boolean;
  needsHelpWallet?: boolean;
  needsHelpDocs?: boolean;
  onboardingNotes?: string | null;
  payoutMethod?: PayoutMethod | null;
  payoutAddress?: string | null;
  payoutLabel?: string | null;
}

export async function fetchSelfOnboardingProfile(token: string): Promise<SelfOnboardingProfile> {
  const res = await publicFetch(`/v1/operators/self-onboarding/${encodeURIComponent(token)}`);
  if (!res.ok) {
    if (res.status === 401) throw new Error('El link expiró o no es válido. Pide uno nuevo al admin.');
    throw new Error(await parseOperatorApiError(res, 'Onboarding'));
  }
  return res.json();
}

export async function submitSelfOnboarding(
  token: string,
  dto: SelfOnboardingSubmitDto,
): Promise<{ ok: true }> {
  const res = await publicFetch(`/v1/operators/self-onboarding/${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dto),
  });
  if (!res.ok) {
    if (res.status === 401) throw new Error('El link expiró. Pide uno nuevo al admin.');
    throw new Error(await parseOperatorApiError(res, 'Guardado'));
  }
  return res.json();
}

// ─── Public — accept invite ───────────────────────────────────────

export async function acceptInvite(token: string, password: string): Promise<{ ok: true }> {
  const res = await publicFetch('/v1/operators/accept-invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, password }),
  });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Aceptar invitación'));
  return res.json();
}

export const apiBase = API_BASE;
export const wsBase = process.env.NEXT_PUBLIC_WS_URL ?? API_BASE.replace(/^http/, 'ws');

/** Clave para que el API no cree dos veces el mismo cobro (UUID v4 aleatorio de verdad). */
export function newIdempotencyKey(): string {
  return `op-${randomUuid()}`;
}

/**
 * crypto.randomUUID solo existe en HTTPS (o localhost): probando el móvil
 * contra la IP del ordenador, un v4 con getRandomValues, que sí está.
 */
function randomUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
