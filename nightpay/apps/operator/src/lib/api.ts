// Operator app API client (mobile-first PWA).
// Sesion JWT en localStorage, igual patrón que TPV/Admin.

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';

const TOKEN_KEY = 'np_op_token';
const REFRESH_KEY = 'np_op_refresh';
const USER_KEY = 'np_op_user';

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
  walletQrToken?: string | null;
}

// ─── Phase 1B — Wallet ─────────────────────────────────────────────

export interface ConsumeWalletResult {
  consumptionId: string;
  newBalanceCents: number;
  earningCreated: boolean;
  earningCommissionCents: number | null;
}

export interface WalletPublicView {
  id: string;
  balanceCents: number;
  status: 'ACTIVE' | 'EXPIRED' | 'REFUNDED' | 'DEPLETED';
  expiresAt: string | null;
  consumptions: Array<{
    id: string;
    amountCents: number;
    category: string;
    providedByName: string | null;
    createdAt: string;
  }>;
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
  return raw ? (JSON.parse(raw) as OperatorUser) : null;
}
export function setSession(login: LoginResponse): void {
  window.localStorage.setItem(TOKEN_KEY, login.accessToken);
  window.localStorage.setItem(REFRESH_KEY, login.refreshToken);
  window.localStorage.setItem(USER_KEY, JSON.stringify(login.user));
}
export function clearSession(): void {
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(REFRESH_KEY);
  window.localStorage.removeItem(USER_KEY);
}

// ─── Auth ─────────────────────────────────────────────────────────

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
      /* best-effort */
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
  window.localStorage.setItem(TOKEN_KEY, refreshed.accessToken);
  window.localStorage.setItem(REFRESH_KEY, refreshed.refreshToken);
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

// ─── Endpoints ────────────────────────────────────────────────────

export async function fetchBalance(): Promise<OperatorBalance> {
  const res = await authedFetch('/v1/operators/me/balance');
  if (!res.ok) throw new Error('Error cargando saldo');
  return res.json();
}

export async function fetchMyEarnings(): Promise<MyEarning[]> {
  const res = await authedFetch('/v1/operators/me/earnings');
  if (!res.ok) throw new Error('Error cargando ganancias');
  return res.json();
}

export async function fetchMyPayments(): Promise<MyPayment[]> {
  const res = await authedFetch('/v1/operators/me/payments');
  if (!res.ok) throw new Error('Error cargando cobros');
  return res.json();
}

export async function fetchMyPayouts(): Promise<MyPayout[]> {
  const res = await authedFetch('/v1/operators/me/payouts');
  if (!res.ok) throw new Error('Error cargando liquidaciones');
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
}): Promise<CreatedPayment> {
  const idemKey = `op-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
  const res = await authedFetch('/v1/payments', {
    method: 'POST',
    headers: { 'Idempotency-Key': idemKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Error: ${await res.text()}`);
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
  if (!res.ok) throw new Error('Error cargando POS pendientes');
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
  if (!res.ok) throw new Error(`Error confirmando: ${await res.text()}`);
  return res.json();
}

export async function cancelPayment(id: string): Promise<{ status: string }> {
  const res = await authedFetch(`/v1/payments/${id}/cancel`, { method: 'POST' });
  if (!res.ok) throw new Error(`Error: ${await res.text()}`);
  return res.json();
}

export async function fetchTerminals(): Promise<Array<{ externalId: string; label: string }>> {
  const res = await authedFetch('/v1/venues/me/terminals');
  if (!res.ok) throw new Error('Error cargando terminales');
  return res.json();
}

// ─── Track A — Zonas ──────────────────────────────────────────────

export interface ZoneOption {
  zone: string; // canonical: 'BARRA', 'HABITACIONES', 'MESAS', 'OTRO/<custom>'
  zoneDisplay: string;
  terminalCount: number;
  activeCount: number;
}

export async function fetchZones(): Promise<ZoneOption[]> {
  const res = await authedFetch('/v1/terminals/zones');
  if (!res.ok) throw new Error('Error cargando zonas');
  return res.json();
}

// ─── Phase 1B — Wallet ─────────────────────────────────────────────

/** Lee el wallet del cliente por su qrToken (sin auth). */
export async function fetchWalletPublic(qrToken: string): Promise<WalletPublicView> {
  const res = await fetch(`${API_BASE}/v1/wallets/public/${encodeURIComponent(qrToken)}`);
  if (!res.ok) throw new Error('Wallet no encontrada');
  return res.json();
}

/** Lista wallets activos del venue — usado por la chica para cobrar sin molestar al cliente. */
export interface ActiveWallet {
  id: string;
  identifier: string | null;
  balanceCents: number;
  status: 'ACTIVE' | 'EXPIRED' | 'REFUNDED' | 'DEPLETED';
  consumptionCount: number;
  createdAt: string;
}

export async function fetchActiveWallets(): Promise<ActiveWallet[]> {
  const res = await authedFetch('/v1/wallets');
  if (!res.ok) throw new Error('Error cargando wallets activos');
  return res.json();
}

/**
 * Cobra una cantidad al balance de un wallet. La chica escanea el QR del
 * cliente y la app llama esto. Si la chica es OPERATOR, el backend genera
 * automáticamente el OperatorEarning con su comisión.
 */
export async function consumeWallet(input: {
  walletId: string;
  amountCents: number;
  category: string;
  notes?: string;
}): Promise<ConsumeWalletResult> {
  const idemKey = `wc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const res = await authedFetch(`/v1/wallets/${input.walletId}/consume`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idemKey },
    body: JSON.stringify({
      amountCents: input.amountCents,
      category: input.category,
      notes: input.notes,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Cobro a wallet falló: ${body}`);
  }
  return res.json();
}

// ─── Public — Self-onboarding ─────────────────────────────────────

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
  const res = await fetch(`${API_BASE}/v1/operators/self-onboarding/${encodeURIComponent(token)}`);
  if (!res.ok) {
    if (res.status === 401) throw new Error('El link expiró o no es válido. Pide uno nuevo al admin.');
    throw new Error(`Error: ${await res.text()}`);
  }
  return res.json();
}

export async function submitSelfOnboarding(
  token: string,
  dto: SelfOnboardingSubmitDto,
): Promise<{ ok: true }> {
  const res = await fetch(`${API_BASE}/v1/operators/self-onboarding/${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dto),
  });
  if (!res.ok) {
    if (res.status === 401) throw new Error('El link expiró. Pide uno nuevo al admin.');
    throw new Error(`Error guardando: ${await res.text()}`);
  }
  return res.json();
}

// ─── Public — accept invite ───────────────────────────────────────

export async function acceptInvite(token: string, password: string): Promise<{ ok: true }> {
  const res = await fetch(`${API_BASE}/v1/operators/accept-invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, password }),
  });
  if (!res.ok) throw new Error(`Error: ${await res.text()}`);
  return res.json();
}

export const apiBase = API_BASE;
export const wsBase = process.env.NEXT_PUBLIC_WS_URL ?? API_BASE.replace(/^http/, 'ws');
