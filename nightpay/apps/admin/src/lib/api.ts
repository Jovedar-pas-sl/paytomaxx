// Admin API client — JWT en localStorage, mismo flujo que TPV.

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
  if (!res.ok) throw new Error(`Error: ${await res.text()}`);
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
  if (!res.ok) throw new Error(`Error: ${await res.text()}`);
  return res.json();
}

export async function switchTenant(
  tenantId: string,
): Promise<{ accessToken: string; expiresIn: number; tenantId: string; venueSlug: string }> {
  const res = await authedFetch('/v1/auth/switch-tenant', {
    method: 'POST',
    body: JSON.stringify({ tenantId }),
  });
  if (!res.ok) throw new Error(`Error: ${await res.text()}`);
  return res.json();
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
  attempts?: Array<{ providerTxId: string; status: string; createdAt: string }>;
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
  return raw ? (JSON.parse(raw) as User) : null;
}

export function setSession(login: LoginResponse): void {
  window.localStorage.setItem(TOKEN_KEY, login.accessToken);
  window.localStorage.setItem(REFRESH_KEY, login.refreshToken);
  window.localStorage.setItem(USER_KEY, JSON.stringify(login.user));
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
      // Best-effort — siempre limpiamos local aunque el server falle
    }
  }
  clearSession();
}

/**
 * Cambia el refresh token por un access token nuevo.
 * Devuelve el nuevo access token y rota el refresh.
 * Si el refresh es invalido (caducado, reusado, revocado), limpia la sesion y lanza.
 */
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

// ─── Helpers ───────────────────────────────────────────────────────

/** Mensaje legible de un error del API (ProblemDetails: detail / title). */
async function readError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const body = JSON.parse(text) as { detail?: unknown; title?: unknown; message?: unknown };
    const msg = body.detail ?? body.message ?? body.title;
    if (typeof msg === 'string' && msg) return msg;
    if (Array.isArray(msg)) return msg.join(' · ');
  } catch {
    // no es JSON
  }
  return text || `Error ${res.status}`;
}

/**
 * Fetch autenticado con auto-refresh en 401:
 *   1. Intenta con el access token actual
 *   2. Si recibe 401 y tenemos refresh token, intercambia y reintenta UNA vez
 *   3. Si el reintento falla (o no hay refresh), limpia sesion y lanza
 */
async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  if (!token) throw new Error('No autenticado');
  const res = await doFetch(path, init, token);
  if (res.status !== 401) return res;

  // 401 — probar refresh una vez
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

export async function fetchPaymentDetail(id: string): Promise<PaymentRow> {
  const res = await authedFetch(`/v1/payments/${id}`);
  if (!res.ok) throw new Error('Error cargando pago');
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
  if (!res.ok) throw new Error(`Error: ${await res.text()}`);
  return res.json();
}

/**
 * Resolver a mano un pago atascado (sin confirmar, o >15 min esperando al
 * banco). Para darlo por cobrado hace falta el código de autorización del banco.
 */
export async function resolveStuckPayment(
  paymentId: string,
  input: { decision: 'AUTHORIZED' | 'FAILED'; reason: string; bankAuthCode?: string },
): Promise<{ ok: true; newStatus: string }> {
  const res = await authedFetch(`/v1/admin/payments/${paymentId}/manual-reconcile`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await readError(res));
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
  if (!res.ok) throw new Error(`Error: ${await res.text()}`);
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
  if (!res.ok) throw new Error(`Error: ${await res.text()}`);
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
  if (!res.ok) throw new Error(`Error: ${await res.text()}`);
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
  if (!res.ok) throw new Error(`Error: ${await res.text()}`);
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
  if (!res.ok) throw new Error(`Error: ${await res.text()}`);
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
  },
): Promise<{ id: string; totalCents: number; earningCount: number; createdAt: string }> {
  const res = await authedFetch(`/v1/admin/operators/${id}/payouts`, {
    method: 'POST',
    body: JSON.stringify(options ?? {}),
  });
  if (!res.ok) throw new Error(`Error: ${await res.text()}`);
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
  identifier: string | null;
  balanceCents: number;
  status: 'ACTIVE' | 'EXPIRED' | 'REFUNDED' | 'DEPLETED';
  expiresAt: string | null;
  qrToken: string;
  consumptionCount: number;
  createdAt: string;
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

export async function refundWallet(
  walletId: string,
  input: { method: 'CARD' | 'CREDIT'; notes?: string },
): Promise<{ walletId: string; refundedCents: number; newStatus: string }> {
  const res = await authedFetch(`/v1/wallets/${walletId}/refund`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Refund falló: ${await res.text()}`);
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
  if (!res.ok) throw new Error(`Error: ${await res.text()}`);
  return res.json();
}

export async function confirmPayoutManual(payoutId: string): Promise<{ ok: true }> {
  const res = await authedFetch(`/v1/admin/treasury/payouts/${payoutId}/confirm-manual`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`Error: ${await res.text()}`);
  return res.json();
}

export async function reconcilePending(): Promise<{ checked: number; matched: number }> {
  const res = await authedFetch('/v1/admin/treasury/reconcile', {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`Error: ${await res.text()}`);
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
  if (!res.ok) throw new Error('Error cargando ajustes');
  return res.json();
}

export async function updateVenueSettings(input: {
  operatorMaxCobroCents?: number;
  platformCommissionBps?: number;
  operatorCommissionDefaults?: Partial<OperatorCommissionDefaults>;
}): Promise<VenueSettings> {
  const res = await authedFetch('/v1/admin/venue/settings', {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Error: ${await res.text()}`);
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
}

export interface Zone {
  zone: string;
  zoneDisplay: string;
  terminalCount: number;
  activeCount: number;
}

export async function fetchTerminals(): Promise<Terminal[]> {
  const res = await authedFetch('/v1/terminals');
  if (!res.ok) throw new Error('Error cargando terminales');
  return res.json();
}

export async function fetchZones(): Promise<Zone[]> {
  const res = await authedFetch('/v1/terminals/zones');
  if (!res.ok) throw new Error('Error cargando zonas');
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
  if (!res.ok) throw new Error(`Error: ${await res.text()}`);
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
  if (!res.ok) throw new Error(`Error: ${await res.text()}`);
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
  if (!res.ok) throw new Error(`Error: ${await res.text()}`);
  return res.json();
}
