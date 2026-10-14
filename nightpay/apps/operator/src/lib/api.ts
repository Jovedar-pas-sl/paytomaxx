// Operator app API client (mobile-first PWA).
// Sesion JWT en localStorage, igual patrón que TPV/Admin.

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';

const TOKEN_KEY = 'np_op_token';
const REFRESH_KEY = 'np_op_refresh';
const USER_KEY = 'np_op_user';

/**
 * Convierte error HTTP en mensaje legible para la chica en un club ruidoso.
 * Prioriza el `detail` del backend cuando viene en formato Problem Details
 * RFC 7807. Para 4xx/5xx mapea a frases concretas.
 *
 * NO devolvemos JSON crudo, stack, ni códigos técnicos.
 */
export async function parseOperatorApiError(res: Response, context: string): Promise<string> {
  const status = res.status;
  let backendDetail: string | undefined;
  try {
    const text = await res.text();
    if (text.startsWith('{')) {
      const parsed = JSON.parse(text) as {
        title?: string;
        detail?: string;
        message?: string;
        userMessage?: string;
      };
      backendDetail = parsed.userMessage ?? parsed.detail ?? parsed.message ?? parsed.title;
    } else if (text && text.length < 100) {
      backendDetail = text;
    }
  } catch {
    // ignore
  }

  if (status === 401) return 'Tu sesión ha caducado. Vuelve a iniciar sesión.';
  if (status === 403) return 'No tienes permiso para esta acción.';
  if (status === 404) return `${context} no encontrado.`;
  if (status === 409) {
    if (backendDetail && backendDetail.length < 120) return backendDetail;
    return 'Esta operación ya está en curso o no se puede repetir.';
  }
  if (status === 422) {
    if (backendDetail && backendDetail.length < 200) return backendDetail;
    return 'Los datos enviados no son válidos.';
  }
  if (status === 429) return 'Demasiados intentos. Espera un momento.';
  if (status >= 500) return 'El servidor está teniendo problemas. Vuelve a intentarlo en unos segundos.';
  if (backendDetail && backendDetail.length < 200) return backendDetail;
  return `${context} no se pudo completar.`;
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

// ─── Phase 1B — Wallet ─────────────────────────────────────────────

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
    clearSession();
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
    if (res.status === 401 || res.status === 403) clearSession();
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
    newToken = await refreshAccessToken(token);
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
  if (!res.ok) throw new Error('Error cargando tu noche');
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
  /** Recargar el saldo que ya tiene el cliente (otra noche o más dinero). */
  walletId?: string;
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
  if (input.walletId) {
    body.wallet = { walletId: input.walletId };
  } else if (input.walletIdentifier) {
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
  if (!res.ok) throw new Error('Error cargando la carta');
  return res.json();
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

// ─── Saldo NightPay: cobrar del saldo con confirmación del cliente ───

/** Saldo del cliente encontrado por el código que enseña en su móvil. */
export interface WalletLookup {
  walletId: string;
  code: string;
  balanceCents: number;
  label: string | null;
  homeVenueName: string;
  isHomeVenue: boolean;
  closeRequested: boolean;
  pendingRequest: boolean;
  /** El cliente ya eligió su PIN (si no, lo elige antes del primer cobro). */
  hasPin: boolean;
  /** 5 PIN fallidos: bloqueado hasta que lo desbloquee el encargado. */
  pinLocked: boolean;
  /** Tiene pulsera o tarjeta NFC. */
  hasTag: boolean;
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

/** El saldo por la pulsera NFC del cliente. */
export async function lookupWalletTag(tag: string): Promise<WalletLookup> {
  const res = await authedFetch(`/v1/wallet-charges/lookup-tag/${encodeURIComponent(tag)}`);
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Pulsera'));
  return res.json();
}

/** El saldo por su id (la recarga recién cobrada). */
export async function fetchWalletById(walletId: string): Promise<WalletLookup> {
  const res = await authedFetch(`/v1/wallet-charges/wallets/${encodeURIComponent(walletId)}`);
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Saldo'));
  return res.json();
}

/** Cobrar del saldo con el PIN del cliente: se cobra al momento. */
export async function chargeWalletWithPin(input: {
  code: string;
  serviceItemId?: string;
  amountCents?: number;
  pin: string;
  /** Una por cobro: si se repite (se cortó la red), el mismo cobro. */
  idempotencyKey?: string;
}): Promise<WalletChargeRequest> {
  const res = await authedFetch('/v1/wallet-charges/pin-charge', { method: 'POST', body: JSON.stringify(input) });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Cobro del saldo'));
  return res.json();
}

/** El cliente elige su PIN en este móvil (solo si aún no tiene). */
export async function setWalletPin(code: string, pin: string): Promise<WalletLookup> {
  const res = await authedFetch('/v1/wallet-charges/pin', { method: 'POST', body: JSON.stringify({ code, pin }) });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'PIN'));
  return res.json();
}

/** Pulsera o tarjeta NFC para este saldo. */
export async function assignWalletTag(code: string, tag: string): Promise<WalletLookup> {
  const res = await authedFetch('/v1/wallet-charges/tag', { method: 'POST', body: JSON.stringify({ code, tag }) });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Pulsera'));
  return res.json();
}

/** Pide el cobro: con un servicio de la carta o un importe. */
export async function requestWalletCharge(input: {
  code: string;
  serviceItemId?: string;
  amountCents?: number;
}): Promise<WalletChargeRequest> {
  const res = await authedFetch('/v1/wallet-charges', { method: 'POST', body: JSON.stringify(input) });
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
    throw new Error(await parseOperatorApiError(res, 'Onboarding'));
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
    throw new Error(await parseOperatorApiError(res, 'Guardado'));
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
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Aceptar invitación'));
  return res.json();
}

export const apiBase = API_BASE;
export const wsBase = process.env.NEXT_PUBLIC_WS_URL ?? API_BASE.replace(/^http/, 'ws');

/** Clave para que el API no cree dos veces el mismo cobro. */
export function newIdempotencyKey(): string {
  return `op-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
