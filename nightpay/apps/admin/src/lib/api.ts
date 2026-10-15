// Admin API client — JWT en localStorage, mismo flujo que TPV.

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

export interface VenueListItem {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  createdAt: string;
}

export async function fetchAllVenues(): Promise<VenueListItem[]> {
  const res = await authedFetch('/v1/admin/venues');
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function createVenue(input: {
  name: string;
  slug: string;
  timezone?: string;
}): Promise<VenueListItem> {
  const res = await authedFetch('/v1/admin/venues', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
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

export interface OperatorBalance {
  pendingCents: number;
  /** Lo que se pagaría ahora: comisiones pasados los días de espera, menos deuda. */
  availableCents?: number;
  heldCents?: number;
  debtCents?: number;
  paidCents: number;
  lifetimeGrossCents: number;
  count: number;
}

export type PayoutMethod =
  | 'USDT_TRC20'
  | 'USDT_BEP20'
  | 'USDC_POLY'
  | 'USDC_SOL'
  | 'BINANCE_PAY_ID'
  | 'OKX_INTERNAL'
  | 'BYBIT_INTERNAL'
  | 'FASTERPAY_EMAIL'
  | 'PAYQUICKER_EMAIL'
  | 'HYPERWALLET_TOKEN'
  | 'REVOLUT_TAG'
  | 'PAYONEER_EMAIL'
  | 'SEPA_IBAN'
  | 'WIRE_INTERNATIONAL'
  | 'MERCADOPAGO_CVU'
  | 'PIX_KEY'
  | 'NEQUI_PHONE'
  | 'DAVIPLATA_PHONE'
  | 'MANUAL_CASH';

export type ReconciliationStatus = 'UNRECONCILED' | 'MATCHED' | 'MANUAL_OK' | 'MISMATCH';

export interface PayoutMetadata {
  bankName?: string;
  swiftBic?: string;
  country?: string;
  accountHolder?: string;
}

export type WalletProvider =
  | 'BINANCE' | 'BYBIT' | 'OKX' | 'CRYPTO_COM' | 'TRUST_WALLET'
  | 'FASTERPAY' | 'PAYQUICKER' | 'WISE' | 'REVOLUT' | 'OTHER' | 'NONE';

export type WalletStatus =
  | 'NOT_STARTED' | 'REGISTERED' | 'KYC_PENDING' | 'KYC_VERIFIED' | 'KYC_REJECTED';

export type OnboardingStatus =
  | 'NEW' | 'PROFILE_CREATED' | 'INVITE_ACTIVATED' | 'BINANCE_PENDING' | 'READY' | 'BLOCKED';

export interface Operator {
  id: string;
  email: string;
  displayName: string | null;
  commissionBps: number;
  active: boolean;
  invitedAt: string | null;
  createdAt: string;
  balance: OperatorBalance;
  // Phase 1A — payout
  payoutMethod?: PayoutMethod | null;
  payoutAddress?: string | null;
  payoutMetadata?: PayoutMetadata | null;
  payoutLabel?: string | null;
  // Phase 1A.1 — onboarding
  phone?: string | null;
  passportCountry?: string | null;
  passportLast4?: string | null;
  hasEmpadronamiento?: boolean;
  hasNie?: boolean;
  hasTie?: boolean;
  walletProvider?: WalletProvider | null;
  walletStatus?: WalletStatus | null;
  walletTestPassed?: boolean;
  walletTestAt?: string | null;
  needsHelpWallet?: boolean;
  needsHelpDocs?: boolean;
  onboardingStatus?: OnboardingStatus;
  onboardingNotes?: string | null;
}

export interface OperatorEarning {
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

export interface OperatorPayout {
  id: string;
  totalCents: number;
  paidByEmail: string | null;
  notes: string | null;
  earningCount: number;
  createdAt: string;
  externalTxId?: string | null;
  externalRail?: PayoutMethod | null;
  reconciliationStatus?: ReconciliationStatus;
  receiptUrl?: string | null;
  reconciledAt?: string | null;
}

export interface TreasuryStats {
  pendingPayoutsCents: number;
  pendingOperatorCount: number;
  payoutsThisMonthCount: number;
  payoutsThisMonthCents: number;
  byMethod: Record<string, number>;
  byReconciliationStatus: Record<string, number>;
}

export interface VerifyPayoutResult {
  matched: boolean;
  status: ReconciliationStatus;
  occurredAt: string | null;
  actualAmountCents: number | null;
  reason: string | null;
}

export interface CreateOperatorResponse {
  operator: Omit<Operator, 'balance'>;
  inviteUrl: string;
  emailSent: boolean;
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

export interface PaymentRow {
  id: string;
  amountCents: number;
  availableAmountCents: number;
  currency: string;
  status: string;
  provider: string | null;
  providerTxId: string | null;
  createdAt: string;
  updatedAt: string;
  // Datos del banco (Fase 0). Null en cobros antiguos o sin aviso.
  authCode?: string | null;
  cardLast4?: string | null;
  cardBrand?: string | null;
  payMethodCode?: string | null;
  authorizedAt?: string | null;
  // Fase 1B: total y propina que se mandaron al banco en cada intento (null = antes de 1B).
  attempts?: Array<{
    providerTxId: string;
    status: string;
    createdAt: string;
    amountCents?: number | null;
    tipCents?: number | null;
  }>;
  terminal: { externalId: string; label: string };
}

export interface Metrics {
  today: { count: number; grossCents: number; refundedCents: number; netCents: number };
  week: { count: number; grossCents: number; refundedCents: number; netCents: number };
  statusBreakdown: Record<string, number>;
}

export interface Refund {
  id: string;
  paymentId: string;
  amountCents: number;
  reason: string | null;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  providerRefundId: string | null;
  createdAt: string;
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
async function apiError(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => '');
  const { message, code } = errorFromBody(text, res.status);
  return new ApiError(message, res.status, code);
}

/** Igual, con los errores de 2FA (que el API da en inglés) en castellano. */
async function totpAwareError(res: Response): Promise<ApiError> {
  const err = await apiError(res);
  return new ApiError(humanizeTotpError(err.message), err.status, err.code);
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
async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
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

// ─── Endpoints ─────────────────────────────────────────────────────

export async function fetchMetrics(): Promise<Metrics> {
  const res = await authedFetch('/v1/admin/metrics');
  if (!res.ok) throw new Error('Error cargando métricas');
  return res.json();
}

export async function fetchPayments(params: {
  status?: string[];
  cursor?: string;
  limit?: number;
}): Promise<{ items: PaymentRow[]; nextCursor: string | null }> {
  const qs = new URLSearchParams();
  if (params.status && params.status.length) qs.set('status', params.status.join(','));
  if (params.cursor) qs.set('cursor', params.cursor);
  if (params.limit) qs.set('limit', String(params.limit));
  const res = await authedFetch(`/v1/admin/payments?${qs.toString()}`);
  if (!res.ok) throw new Error('Error cargando pagos');
  return res.json();
}

export async function fetchRefunds(paymentId: string): Promise<Refund[]> {
  const res = await authedFetch(`/v1/payments/${paymentId}/refunds`);
  if (!res.ok) throw new Error('Error cargando refunds');
  return res.json();
}

export async function refundPayment(
  paymentId: string,
  amountCents: number,
  reason?: string,
  totpCode?: string,
): Promise<{ id: string; status: string; providerRefundId: string }> {
  const res = await authedFetch(`/v1/payments/${paymentId}/refunds`, {
    method: 'POST',
    body: JSON.stringify({ amountCents, reason, totpCode }),
  });
  if (!res.ok) throw await totpAwareError(res);
  return res.json();
}

/**
 * Resolver a mano un pago atascado (sin confirmar, o >15 min esperando al
 * banco). Para darlo por cobrado hace falta el código de autorización del banco.
 */
export async function resolveStuckPayment(
  paymentId: string,
  input: { decision: 'AUTHORIZED' | 'FAILED'; reason: string; bankAuthCode?: string; bankOrder?: string },
): Promise<{ ok: true; newStatus: string }> {
  const res = await authedFetch(`/v1/admin/payments/${paymentId}/manual-reconcile`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/** Fase 1C — devolución ya hecha en el portal de BBVA (no mueve dinero). */
export interface BankRefundInput {
  amountCents: number;
  reason: string;
  bankReference?: string;
  /** AAAA-MM-DD */
  refundedOn?: string;
  confirmDuplicate?: boolean;
}

export async function registerBankRefund(
  paymentId: string,
  input: BankRefundInput,
): Promise<{ id: string; status: string }> {
  const res = await authedFetch(`/v1/payments/${paymentId}/refunds/bank`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/** Fase 1C — informes para la gestoría (CSV). */
export type ExportKind = 'cobros' | 'devoluciones' | 'liquidaciones' | 'resumen';

export async function downloadExport(kind: ExportKind, from: string, to: string): Promise<Blob> {
  const qs = new URLSearchParams({ from, to }).toString();
  const res = await authedFetch(`/v1/admin/export/${kind}?${qs}`);
  if (!res.ok) throw await apiError(res);
  return res.blob();
}

// ─── Incidencias (Fase 1E) ─────────────────────────────────────────

export type IncidentKind =
  | 'stuck_payment'
  | 'duplicate_charge'
  | 'earning_reverse_failed'
  | 'wallet_credit_skipped'
  | 'night_closed_pending'
  | 'pos_charge_mismatch'
  | 'pos_unmatched_op'
  | 'pos_unreconciled'
  | 'wallet_close_requested'
  | 'wallet_open_balance'
  | 'bank_mismatch'
  | 'backup_stale'
  | 'backup_unmonitored';

export interface Incident {
  kind: IncidentKind;
  refId: string;
  title: string;
  detail: string;
  occurredAt: string;
  amountCents: number | null;
  paymentId: string | null;
  ackable: boolean;
}

export async function fetchIncidents(): Promise<{ items: Incident[]; telegram: boolean }> {
  const res = await authedFetch('/v1/incidents');
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function ackIncident(input: { kind: IncidentKind; refId: string; note?: string }): Promise<void> {
  const res = await authedFetch('/v1/incidents/ack', { method: 'POST', body: JSON.stringify(input) });
  if (!res.ok) throw await apiError(res);
}

export async function sendTelegramTest(): Promise<boolean> {
  const res = await authedFetch('/v1/incidents/telegram-test', { method: 'POST', body: '{}' });
  if (!res.ok) throw await apiError(res);
  return ((await res.json()) as { sent: boolean }).sent;
}

// ─── Noches (Fase 1D) ──────────────────────────────────────────────

export interface NightSummary {
  count: number;
  grossCents: number;
  tipsCents: number;
  chargedCents: number;
  refundsCount: number;
  refundsCents: number;
  netCents: number;
  byType: Array<{ label: string; count: number; chargedCents: number }>;
  chicaCommissionCents: number;
  chicaTipsCents: number;
  chicaReversalsCents: number;
  chicaNetCents: number;
  venueTipsCents: number;
  venueNetCents: number;
  payoutsCount: number;
  payoutsCents: number;
  perChica: Array<{
    name: string;
    count: number;
    chargedCents: number;
    commissionCents: number;
    tipsCents: number;
    reversalsCents: number;
    netCents: number;
    paidCents: number;
  }>;
}

export interface NightZ {
  from: string;
  to: string;
  generatedAt: string;
  summary: NightSummary;
  pendingCount: number;
}

export interface NightView {
  id: string;
  openedAt: string;
  closedAt: string | null;
  autoClosed: boolean;
  pendingAtClose: number;
  closeNote: string | null;
  z: NightZ;
  pending: Array<{ id: string; status: string; amountCents: number; createdAt: string; captureMethod: string | null }>;
}

export interface NightListItem {
  id: string;
  openedAt: string;
  closedAt: string | null;
  autoClosed: boolean;
  pendingAtClose: number;
  count: number | null;
  chargedCents: number | null;
  netCents: number | null;
}

export async function fetchCurrentNight(): Promise<NightView | null> {
  const res = await authedFetch('/v1/nights/current');
  if (!res.ok) throw await apiError(res);
  return ((await res.json()) as { night: NightView | null }).night;
}

export async function openNight(): Promise<NightView> {
  const res = await authedFetch('/v1/nights/open', { method: 'POST', body: '{}' });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function closeNight(id: string, input: { force?: boolean; note?: string }): Promise<NightView> {
  const res = await authedFetch(`/v1/nights/${id}/close`, { method: 'POST', body: JSON.stringify(input) });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function fetchNights(): Promise<NightListItem[]> {
  const res = await authedFetch('/v1/nights');
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function fetchNight(id: string): Promise<NightView> {
  const res = await authedFetch(`/v1/nights/${id}`);
  if (!res.ok) throw await apiError(res);
  return res.json();
}

// ─── Operadoras ────────────────────────────────────────────────────

export async function fetchOperators(): Promise<Operator[]> {
  const res = await authedFetch('/v1/admin/operators');
  if (!res.ok) throw new Error('Error cargando operadoras');
  return res.json();
}

export async function createOperator(input: {
  email: string;
  displayName: string;
  commissionBps: number;
}): Promise<CreateOperatorResponse> {
  const res = await authedFetch('/v1/admin/operators', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function updateOperator(
  id: string,
  input: {
    displayName?: string;
    commissionBps?: number;
    active?: boolean;
    payoutMethod?: PayoutMethod | null;
    payoutAddress?: string | null;
    payoutMetadata?: PayoutMetadata | null;
    payoutLabel?: string | null;
    // Onboarding fields
    phone?: string | null;
    passportCountry?: string | null;
    passportLast4?: string | null;
    hasEmpadronamiento?: boolean;
    hasNie?: boolean;
    hasTie?: boolean;
    walletProvider?: WalletProvider | null;
    walletStatus?: WalletStatus | null;
    walletTestPassed?: boolean;
    needsHelpWallet?: boolean;
    needsHelpDocs?: boolean;
    onboardingStatus?: OnboardingStatus;
    onboardingNotes?: string | null;
  },
): Promise<Omit<Operator, 'balance'>> {
  const res = await authedFetch(`/v1/admin/operators/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/**
 * Genera (o rota) un link self-onboarding 72h para la operadora. El admin
 * copia el link y se lo manda a la chica vía WhatsApp. Ella lo abre sin login.
 */
export async function createSelfOnboardingLink(
  operatorId: string,
): Promise<{ url: string; expiresAt: string }> {
  const res = await authedFetch(`/v1/admin/operators/${operatorId}/self-onboarding-link`, {
    method: 'POST',
    body: '{}',
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/**
 * Re-emite invite link 24h para una operadora todavía sin activar (estado
 * "pendiente"). Si la chica ya activó pass → 409, usar resetOperatorPassword.
 */
export async function regenerateInvite(
  operatorId: string,
): Promise<{ inviteUrl: string; expiresAt: string }> {
  const res = await authedFetch(`/v1/admin/operators/${operatorId}/regenerate-invite`, {
    method: 'POST',
    body: '{}',
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/**
 * Resetea la contraseña de la operadora. Si `password` es null → backend
 * genera una random 12 chars. Devuelve la pass en CLARO una sola vez para
 * que el admin la copie y la mande por WhatsApp.
 */
export async function resetOperatorPassword(
  operatorId: string,
  password: string | null,
): Promise<{ password: string; reset: true }> {
  const body = password ? { password } : {};
  const res = await authedFetch(`/v1/admin/operators/${operatorId}/reset-password`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function fetchOperatorEarnings(id: string): Promise<OperatorEarning[]> {
  const res = await authedFetch(`/v1/admin/operators/${id}/earnings`);
  if (!res.ok) throw new Error('Error cargando earnings');
  return res.json();
}

export async function fetchOperatorPayouts(id: string): Promise<OperatorPayout[]> {
  const res = await authedFetch(`/v1/admin/operators/${id}/payouts`);
  if (!res.ok) throw new Error('Error cargando payouts');
  return res.json();
}

export async function createOperatorPayout(
  id: string,
  options?: {
    notes?: string;
    externalTxId?: string;
    externalRail?: PayoutMethod;
    receiptUrl?: string;
    /** Código 2FA (obligatorio si el dueño lo tiene activado). */
    totpCode?: string;
  },
): Promise<{ id: string; totalCents: number; earningCount: number; createdAt: string }> {
  const res = await authedFetch(`/v1/admin/operators/${id}/payouts`, {
    method: 'POST',
    body: JSON.stringify(options ?? {}),
  });
  if (!res.ok) throw await totpAwareError(res);
  return res.json();
}

// ─── Treasury (Phase 1A) ───────────────────────────────────────────

export async function fetchTreasuryStats(): Promise<TreasuryStats> {
  const res = await authedFetch('/v1/admin/treasury/stats');
  if (!res.ok) throw new Error('Error cargando treasury stats');
  return res.json();
}

// ─── Phase 1B — Wallets ─────────────────────────────────────────────

export interface WalletAdminRow {
  id: string;
  /** Código que el cliente ve en su página de saldo (K7Q-4M2). */
  code: string | null;
  /** El cliente pulsó "Me voy: devolver mi saldo". */
  closeRequestedAt: string | null;
  identifier: string | null;
  balanceCents: number;
  status: 'ACTIVE' | 'EXPIRED' | 'REFUNDED' | 'DEPLETED';
  expiresAt: string | null;
  consumptionCount: number;
  createdAt: string;
  /** El cliente activó Face ID (paga escaneando el QR de la chica). */
  hasFaceId: boolean;
  /** Puede pagar sin sacar el móvil, con su PIN. */
  hasPin: boolean;
  /** 5 PIN fallidos: no puede pagar con PIN hasta que lo desbloquees. */
  pinLocked: boolean;
  /** Tiene ficha NFC activa. */
  hasCard: boolean;
}

/** Cobro con QR que la chica hizo y nadie ha pagado aún. */
export interface PendingQrCharge {
  id: string;
  amountCents: number;
  serviceName: string | null;
  requestedByName: string;
  createdAt: string;
  expiresAt: string;
}

/** Encargado o dueño: cobros con QR sin pagar (cliente sin batería…). */
export async function fetchPendingQrCharges(): Promise<PendingQrCharge[]> {
  const res = await authedFetch('/v1/wallet-charges/pending-qr');
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/** Encargado o dueño: cobrar ese cobro de este saldo, sin Face ID (queda registrado). */
export async function approveQrCharge(requestId: string, walletId: string): Promise<void> {
  const res = await authedFetch(`/v1/wallet-charges/${encodeURIComponent(requestId)}/approve`, {
    method: 'POST',
    body: JSON.stringify({ walletId }),
  });
  if (!res.ok) throw await apiError(res);
}

/** Encargado o dueño: tras 5 PIN fallidos, el cliente vuelve a poder probar. */
export async function unlockWalletPin(walletId: string): Promise<void> {
  const res = await authedFetch(`/v1/wallet-charges/wallets/${encodeURIComponent(walletId)}/pin/unlock`, { method: 'POST' });
  if (!res.ok) throw await apiError(res);
}

/** Encargado o dueño: ficha NFC perdida → bloqueada (el saldo sigue con Face ID o código + PIN). */
export async function blockWalletCard(walletId: string): Promise<void> {
  const res = await authedFetch(`/v1/wallet-charges/wallets/${encodeURIComponent(walletId)}/card/block`, { method: 'POST' });
  if (!res.ok) throw await apiError(res);
}

/** Encargado o dueño: el cliente olvidó su PIN → se borra y elige otro. */
export async function resetWalletPin(walletId: string): Promise<void> {
  const res = await authedFetch(`/v1/wallet-charges/wallets/${encodeURIComponent(walletId)}/pin/reset`, { method: 'POST' });
  if (!res.ok) throw await apiError(res);
}

export interface WalletsAdminStats {
  activeCount: number;
  totalBalanceCents: number;
  todayTopUpsCents: number;
  todayConsumptionsCents: number;
  todayRefundsCents: number;
  byCategory: Record<string, number>;
}

export async function fetchWalletsStats(): Promise<WalletsAdminStats> {
  const res = await authedFetch('/v1/admin/wallets/stats');
  if (!res.ok) throw new Error('Error cargando stats de wallets');
  return res.json();
}

export async function fetchWalletsList(params?: {
  status?: WalletAdminRow['status'];
  limit?: number;
}): Promise<WalletAdminRow[]> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set('status', params.status);
  if (params?.limit) qs.set('limit', String(params.limit));
  const res = await authedFetch(`/v1/admin/wallets?${qs.toString()}`);
  if (!res.ok) throw new Error('Error cargando wallets');
  return res.json();
}

/** Saldo de un cliente por su código (vale el de cualquier local del grupo). */
export interface WalletLookup {
  walletId: string;
  code: string;
  balanceCents: number;
  label: string | null;
  homeVenueName: string;
  /** El saldo se cargó en este local (la devolución a la tarjeta solo desde aquí). */
  isHomeVenue: boolean;
  /** El cliente pulsó "Me voy". */
  closeRequested: boolean;
  pendingRequest: boolean;
}

export async function lookupWalletCode(code: string): Promise<WalletLookup> {
  const res = await authedFetch(`/v1/wallet-charges/lookup/${encodeURIComponent(code)}`);
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/**
 * El cliente perdió el enlace de su saldo: uno nuevo (solo el dueño). El viejo
 * deja de valer. Devuelve el enlace y su QR para que el cliente lo escanee.
 */
export async function relinkWallet(walletId: string): Promise<{ url: string; qrDataUrl: string }> {
  const res = await authedFetch(`/v1/wallet-charges/wallets/${encodeURIComponent(walletId)}/relink`, {
    method: 'POST',
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export type WalletPayoutMethod = 'CARD' | 'CASH';

/**
 * Devolver el saldo al cliente que se va. Efectivo: se lo das ahora.
 * Tarjeta (solo el dueño): primero se devuelve en el portal de BBVA y aquí se
 * apunta, repartido entre sus recargas.
 */
export async function payoutWallet(
  walletId: string,
  input: { method: WalletPayoutMethod; bankReference?: string; note?: string },
): Promise<{ refundedCents: number; method: WalletPayoutMethod }> {
  const res = await authedFetch(`/v1/wallet-charges/wallets/${encodeURIComponent(walletId)}/payout`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function fetchExchangeRate(): Promise<{
  pair: string;
  rate: number;
  at: string;
  degraded: boolean;
}> {
  const res = await authedFetch('/v1/admin/treasury/exchange-rate');
  if (!res.ok) throw new Error('Error cargando exchange rate');
  return res.json();
}

export async function verifyPayout(
  payoutId: string,
  input: {
    externalTxId: string;
    externalRail: PayoutMethod;
    receiptUrl?: string;
    manualOverride?: boolean;
  },
): Promise<VerifyPayoutResult> {
  const res = await authedFetch(`/v1/admin/treasury/payouts/${payoutId}/verify`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/**
 * Marca un pago a una chica como confirmado a mano (métodos sin verificación
 * automática). El API pide al menos una prueba: referencia, recibo o nota.
 */
export async function confirmPayoutManual(
  payoutId: string,
  artifact: { externalTxId?: string; receiptUrl?: string; notes?: string },
): Promise<{ ok: true }> {
  const res = await authedFetch(`/v1/admin/treasury/payouts/${payoutId}/confirm-manual`, {
    method: 'POST',
    body: JSON.stringify(artifact),
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function reconcilePending(): Promise<{ checked: number; matched: number }> {
  const res = await authedFetch('/v1/admin/treasury/reconcile', {
    method: 'POST',
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

// ─── Venue settings (Ajustes) ──────────────────────────────────────

export interface OperatorCommissionDefaults {
  CHICA_SERVICE: number;
  VENUE_BAR: number;
  VENUE_ROOM: number;
  VENUE_FOOD: number;
  EXTRA: number;
}

export interface VenueSettings {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  operatorMaxCobroCents: number;
  platformCommissionBps: number;
  operatorCommissionDefaults: OperatorCommissionDefaults;
}

export async function fetchVenueSettings(): Promise<VenueSettings> {
  const res = await authedFetch('/v1/admin/venue/settings');
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/**
 * El PATCH solo devuelve lo editable (sin nombre, slug ni zona horaria): quien
 * llama lo mezcla con lo que ya tenía.
 */
export async function updateVenueSettings(input: {
  operatorMaxCobroCents?: number;
  platformCommissionBps?: number;
  operatorCommissionDefaults?: Partial<OperatorCommissionDefaults>;
}): Promise<
  Pick<VenueSettings, 'id' | 'operatorMaxCobroCents' | 'platformCommissionBps' | 'operatorCommissionDefaults'>
> {
  const res = await authedFetch('/v1/admin/venue/settings', {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

// ─── Verificación en dos pasos (2FA, app de verificación) ──────────

export interface TotpStatus {
  enabled: boolean;
}

export interface TotpSetup {
  /** otpauth://… (lo mismo que el QR). */
  otpauthUrl: string;
  /** Clave para teclearla en la app si no se puede escanear. */
  secret: string;
  /** QR en PNG como data URL. */
  qrPngDataUrl: string;
}

/** ¿Tiene activada la verificación en dos pasos quien está dentro? (404 = API sin esta función). */
export async function fetchTotpStatus(): Promise<TotpStatus> {
  const res = await authedFetch('/v1/auth/totp');
  if (!res.ok) throw await totpAwareError(res);
  return res.json();
}

/** Empieza a activarla: secreto nuevo + QR. 409 si ya está activada. */
export async function startTotpSetup(): Promise<TotpSetup> {
  const res = await authedFetch('/v1/auth/totp/setup', { method: 'POST', body: '{}' });
  if (!res.ok) throw await totpAwareError(res);
  return res.json();
}

/** Termina de activarla con el primer código de la app. */
export async function confirmTotp(code: string): Promise<TotpStatus> {
  const res = await authedFetch('/v1/auth/totp/confirm', { method: 'POST', body: JSON.stringify({ code }) });
  if (!res.ok) throw await totpAwareError(res);
  return res.json();
}

/** La desactiva (pide un código válido de la app). */
export async function disableTotp(code: string): Promise<TotpStatus> {
  const res = await authedFetch('/v1/auth/totp/disable', { method: 'POST', body: JSON.stringify({ code }) });
  if (!res.ok) throw await totpAwareError(res);
  return res.json();
}

// ─── Terminals (Track A — red PAX por zona) ───────────────────────

export interface Terminal {
  id: string;
  externalId: string;
  label: string;
  zone: string | null;
  zoneDisplay: string | null;
  hardwareModel: string | null;
  deviceSerial: string | null;
  active: boolean;
  /** App NightPay del datáfono vinculada. */
  devicePaired?: boolean;
  deviceLastSeenAt?: string | null;
}

/** Código para vincular la app NightPay de un datáfono (vale 15 minutos). */
export async function createPairingCode(terminalId: string): Promise<{ code: string; expiresAt: string }> {
  const res = await authedFetch(`/v1/pos-device/terminals/${terminalId}/pairing-code`, { method: 'POST', body: '{}' });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function unpairTerminal(terminalId: string): Promise<void> {
  const res = await authedFetch(`/v1/pos-device/terminals/${terminalId}/device`, { method: 'DELETE' });
  if (!res.ok) throw await apiError(res);
}

export async function fetchTerminals(): Promise<Terminal[]> {
  const res = await authedFetch('/v1/terminals');
  if (!res.ok) throw new Error('Error cargando terminales');
  return res.json();
}

export async function createTerminal(input: {
  externalId: string;
  label: string;
  zone?: 'BARRA' | 'HABITACIONES' | 'MESAS' | 'OTRO';
  zoneCustom?: string;
  hardwareModel?: string;
  deviceSerial?: string;
  active?: boolean;
}): Promise<Terminal> {
  const res = await authedFetch('/v1/terminals', {
    method: 'POST',
    body: JSON.stringify({ active: true, ...input }),
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function bulkCreateTerminals(input: {
  count: number;
  prefix: string;
  zone: 'BARRA' | 'HABITACIONES' | 'MESAS' | 'OTRO';
  zoneCustom?: string;
  hardwareModel?: string;
}): Promise<Terminal[]> {
  const res = await authedFetch('/v1/terminals/bulk', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function updateTerminal(
  id: string,
  input: {
    label?: string;
    zone?: 'BARRA' | 'HABITACIONES' | 'MESAS' | 'OTRO' | null;
    zoneCustom?: string | null;
    hardwareModel?: string | null;
    deviceSerial?: string | null;
    active?: boolean;
  },
): Promise<Terminal> {
  const res = await authedFetch(`/v1/terminals/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

// ─── Fase 1A — Carta de servicios ──────────────────────────────────

export type RevenueCategory = 'CHICA_SERVICE' | 'VENUE_BAR' | 'VENUE_ROOM' | 'VENUE_FOOD' | 'EXTRA';

export interface ServiceItem {
  id: string;
  name: string;
  durationMin: number | null;
  priceCents: number;
  category: RevenueCategory;
  active: boolean;
  sortOrder: number;
}

export interface ServiceItemInput {
  name: string;
  durationMin: number | null;
  priceCents: number;
  category: RevenueCategory;
  sortOrder?: number;
}

export async function fetchCarta(): Promise<ServiceItem[]> {
  const res = await authedFetch('/v1/services/all');
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function createServiceItem(input: ServiceItemInput): Promise<ServiceItem> {
  const res = await authedFetch('/v1/services', { method: 'POST', body: JSON.stringify(input) });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function updateServiceItem(
  id: string,
  input: Partial<ServiceItemInput> & { active?: boolean },
): Promise<ServiceItem> {
  const res = await authedFetch(`/v1/services/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

// ─── Cuadre con el banco ─────────────────────────────────────────────

export type BankSource = 'REDSYS' | 'PAYTEF';

export type BankItemStatus =
  | 'MATCHED'
  | 'AMOUNT_MISMATCH'
  | 'NOT_PAID_HERE'
  | 'NOT_IN_OXIOPAY'
  | 'NOT_IN_BANK'
  | 'REFUND_MATCHED'
  | 'REFUND_NOT_IN_OXIOPAY'
  | 'REFUND_NOT_IN_BANK';

export interface BankStatementSummary {
  id: string;
  source: BankSource;
  fileName: string;
  periodFrom: string;
  periodTo: string;
  rowsTotal: number;
  skippedCount: number;
  otherCount: number;
  matchedCount: number;
  problemCount: number;
  bankTotalCents: number;
  oursTotalCents: number;
  superseded: boolean;
  createdAt: string;
}

export interface BankStatementItem {
  id: string;
  status: BankItemStatus;
  kind: 'SALE' | 'REFUND';
  line: number | null;
  occurredAt: string | null;
  bankAmountCents: number | null;
  oursAmountCents: number | null;
  reference: string | null;
  authCode: string | null;
  paymentId: string | null;
  venueName: string | null;
  superseded: boolean;
}

/** El cuerpo de la petición tiene un tope de 1 MB y el fichero va en base64. */
export const MAX_BANK_FILE_BYTES = 700_000;

/** Sube el fichero del portal del banco (Redsys o Paytef) y lo cuadra. */
export async function importBankStatement(input: {
  source: BankSource;
  file: File;
  periodFrom?: string;
  periodTo?: string;
}): Promise<BankStatementSummary> {
  if (input.file.size > MAX_BANK_FILE_BYTES) {
    throw new Error('El fichero es muy grande: descárgalo por semanas');
  }
  const res = await authedFetch('/v1/bank-recon/import', {
    method: 'POST',
    body: JSON.stringify({
      source: input.source,
      fileName: input.file.name,
      contentBase64: await fileToBase64(input.file),
      ...(input.periodFrom && input.periodTo ? { periodFrom: input.periodFrom, periodTo: input.periodTo } : {}),
    }),
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function fetchBankStatements(): Promise<BankStatementSummary[]> {
  const res = await authedFetch('/v1/bank-recon');
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function fetchBankStatement(
  id: string,
): Promise<{ statement: BankStatementSummary; items: BankStatementItem[] }> {
  const res = await authedFetch(`/v1/bank-recon/${encodeURIComponent(id)}`);
  if (!res.ok) throw await apiError(res);
  return res.json();
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
