// Operator app API client (mobile-first PWA). La sesión es la del cliente
// común @nightpay/api-client (igual que el panel y el TPV): el refresh token
// va en una cookie HttpOnly del API y el access token solo en la memoria de
// la pestaña. Aquí, los textos para la chica y los endpoints de la app.

import {
  SELF_ONBOARDING_ALREADY_SAVED,
  type CashTopUpDto,
  type CashTopUpResult,
  type PostCode,
  type ReceptionOptions,
  type SectionCode,
  type StaffQrView,
  type StockOutcome,
  type VenueSection,
} from '@nightpay/contracts';
import {
  ApiError,
  ServerUnavailableError,
  SESSION_EXPIRED_EVENT,
  SessionExpiredError,
  createApiClient,
  isTransientStatus,
  parseProblemDetails,
  tokenExpiresSoon,
  type LoginResult,
  type SessionEvent,
} from '@nightpay/api-client';
import { codeErrorText } from './api-codes';
import type { PolledPayment } from './payment-status';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';

// ─── Errores ──────────────────────────────────────────────────────

/** La sesión se acabó de verdad: la app (page.tsx) lo escucha y vuelve al login. */
export { SESSION_EXPIRED_EVENT };
/**
 * SessionExpiredError: el API dijo que no (refresh rechazado) o ya no hay
 * sesión, hay que volver a entrar. ServerUnavailableError: sin red, servidor
 * caído o saturado (5xx, 429), la sesión sigue y se reintenta.
 */
export { ServerUnavailableError, SessionExpiredError, tokenExpiresSoon };

const SESSION_EXPIRED_TEXT = 'Tu sesión ha caducado. Vuelve a iniciar sesión.';
const SERVER_DOWN_TEXT = 'El servidor está teniendo problemas. Vuelve a intentarlo en unos segundos.';
const NO_CONNECTION_TEXT = 'No se pudo conectar con el servidor. Comprueba la conexión y vuelve a intentarlo.';
const TOO_MANY_TEXT = 'Demasiados intentos. Espera un momento.';

/** Lo que enseña una pantalla que se refresca sola cuando falla una vuelta. */
export function pollErrorText(err: unknown): string {
  if (err instanceof ServerUnavailableError) return 'Servidor no disponible, reintentando…';
  return err instanceof Error ? err.message : 'Algo ha fallado.';
}

/** Una carga que falla: si el servidor está caído o saturado, se dice así (se reintenta sola). */
function loadError(res: Response, message: string): Error {
  return isTransientStatus(res.status) ? new ServerUnavailableError(SERVER_DOWN_TEXT, res.status, 'server') : new Error(message);
}

/**
 * Convierte error HTTP en mensaje legible para la chica en un club ruidoso.
 * Lee el `detail` del backend (Problem Details RFC 7807).
 */
export async function parseOperatorApiError(res: Response, context: string): Promise<string> {
  const text = await res.text().catch(() => '');
  const { message, code } = parseProblemDetails(text);
  return operatorErrorMessage(res.status, message ?? undefined, context, code);
}

/**
 * Error HTTP → frase concreta. El texto del servidor se enseña cuando es
 * corto y no técnico: los 403/409/422 de negocio dicen qué pasa ("El máximo
 * que puedes cobrar de una vez es 300 €", "Este PIN lo pusiste tú…").
 * NO devolvemos JSON crudo, stack, ni códigos técnicos.
 */
export function operatorErrorMessage(
  status: number,
  backendDetail: string | undefined,
  context: string,
  code?: string | null,
): string {
  const detail = shownDetail(backendDetail);
  // Tope de efectivo, saldo bloqueado…: la misma frase en todas partes.
  const known = codeErrorText(code, detail);
  if (known) return known;
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
/** El error de acceso que es culpa de lo escrito (email o contraseña): los dos campos se marcan. */
export const BAD_CREDENTIALS_MESSAGE = 'Email o contraseña incorrectos.';

export function loginErrorMessage(status: number | null, detail?: string): string {
  if (status === null || status >= 500) return 'No se pudo conectar con el servidor. Inténtalo de nuevo.';
  // El bloqueo por fallos llega como 401 "Too many attempts" o como 429.
  if (status === 429 || /too many/i.test(detail ?? '')) {
    return 'Demasiados intentos. Espera unos minutos y vuelve a probar.';
  }
  if (status === 400 || status === 401 || status === 422) return BAD_CREDENTIALS_MESSAGE;
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

/** Lo que devuelve el login: el access token (solo para la memoria) y quién es. El refresh va en la cookie. */
export type LoginResponse = LoginResult<OperatorUser>;

export interface RefreshResponse {
  accessToken: string;
  expiresIn: number;
  refreshExpiresIn?: number;
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
  /** null: lo cobró del saldo del cliente (no hay cobro con tarjeta). */
  paymentId: string | null;
  paymentAmountCents: number;
  commissionBps: number;
  commissionCents: number;
  /** Propina del cliente para ella (entera, sin comisión). */
  tipCents?: number;
  reversedCents: number;
  /** commissionCents + tipCents − reversedCents. */
  netCents: number;
  payoutId: string | null;
  paymentStatus: string | null;
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
  /** Cómo se le pagó (USDT_TRC20, SEPA_IBAN, MANUAL_CASH…). */
  externalRail?: PayoutMethod | null;
}

/** A dónde se le paga, sin la dirección entera («••••1332»). */
export interface PayoutAccount {
  method: PayoutMethod | null;
  label: string | null;
  masked: string | null;
}

/** Devolución de un cobro que ya se le había pagado: se le descuenta de un pago. */
export interface MyDebt {
  id: string;
  paymentId: string | null;
  /** El cobro devuelto. */
  chargeCents: number;
  /** Lo que se le descuenta. */
  cents: number;
  /** Cuándo llegó la devolución. */
  at: string;
  /** Cuándo fue el cobro. */
  chargedAt: string;
  /** null: se descontará del próximo pago. */
  settledPayoutId: string | null;
  settledAt: string | null;
}

export interface MyPayoutInfo {
  /** Días que espera un cobro antes de pagarse (0: al cerrar la noche). */
  holdDays: number;
  account: PayoutAccount | null;
  /** Abiertas primero; luego las ya descontadas. */
  debts: MyDebt[];
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
  /** Referencia corta del cobro (C-0001): la que sale en el PAGADO. */
  ref?: string | null;
  /** Lo cobrado, cada línea en su sección (vacío en una recarga). */
  lines?: Array<{ category: string; label: string; qty: number; unitCents: number; amountCents: number }>;
}

// ─── Sesión ───────────────────────────────────────────────────────

const client = createApiClient<OperatorUser>({
  baseUrl: API_BASE,
  storagePrefix: 'np_op',
  messages: {
    sessionExpired: SESSION_EXPIRED_TEXT,
    network: NO_CONNECTION_TEXT,
    timeout: 'El servidor tarda en responder. Vuelve a intentarlo en unos segundos.',
    server: SERVER_DOWN_TEXT,
    // Un refresco limitado no es «demasiados intentos» de la chica: el servidor no da abasto.
    tooMany: SERVER_DOWN_TEXT,
  },
});

/** El access token de esta pestaña (solo en memoria; null hasta el primer uso). */
export function getToken(): string | null {
  return client.getAccessToken();
}
/** ¿Hay sesión en este móvil? (la cookie dirá si sigue viva al primer uso). */
export function hasSession(): boolean {
  return client.hasSession();
}
/** Quién es la sesión guardada (no secreto). */
export function getUser(): OperatorUser | null {
  return client.getUser();
}
export function setSession(login: LoginResponse): void {
  client.setSession(login);
}
export function clearSession(): void {
  client.clearSession();
}

/** Por qué se acabó la sesión: caducó (aquí o en otra pestaña) o alguien le dio a «Salir». */
export type SessionEndReason = 'expired' | 'logout';

/**
 * Un aviso de la sesión → ¿se acabó? Caducada (aquí o allí) → si hay un cobro
 * abierto se entra encima; «Salir» en otra pestaña, o entró otra persona en
 * otra pestaña → fuera aquí también (no se sigue con la sesión de otra).
 */
export function sessionEndReason(event: SessionEvent): SessionEndReason | null {
  if (event.type === 'expired') return 'expired';
  if (event.type === 'logout' || event.type === 'changed') return 'logout';
  return null;
}

/** Avisa cuando la sesión se acaba (aquí o en otra pestaña). Devuelve cómo dejar de escuchar. */
export function onSessionEnded(handler: (reason: SessionEndReason) => void): () => void {
  return client.onSessionEvent((event) => {
    const reason = sessionEndReason(event);
    if (reason) handler(reason);
  });
}

/**
 * El refresco trajo otro nombre para la misma persona (sesión abierta antes
 * de que el login lo mandara, o el dueño lo cambió en Personal): la página lo
 * pinta sin volver a entrar. Devuelve cómo dejar de escuchar.
 */
export function onProfileUpdated(handler: (user: OperatorUser) => void): () => void {
  return client.onSessionEvent((event) => {
    if (event.type !== 'profile') return;
    const user = client.getUser();
    if (user) handler(user);
  });
}

// ─── Auth ─────────────────────────────────────────────────────────

export async function login(email: string, password: string): Promise<LoginResponse> {
  try {
    return await client.login({ email, password });
  } catch (err) {
    if (err instanceof ServerUnavailableError) throw new Error(loginErrorMessage(null));
    if (err instanceof ApiError) throw new Error(loginErrorMessage(err.status, err.message));
    throw err;
  }
}

/**
 * Salir: la sesión local se borra siempre y al momento (sin esperar a la red),
 * las otras pestañas salen también, y la del servidor se cierra con la cookie
 * aunque el access token ya haya caducado. Devuelve si el servidor lo
 * confirmó (si no, la cookie caduca sola). Nunca falla.
 */
export function logout(): Promise<boolean> {
  return client.logout();
}

/**
 * El access token para el socket en tiempo real (se manda al conectar y al
 * reconectar): si está a punto de caducar, se renueva antes.
 */
export function freshAccessToken(): Promise<string | null> {
  return client.freshAccessToken();
}

export function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return client.authedFetch(path, init);
}

// ─── Endpoints ────────────────────────────────────────────────────

export async function fetchBalance(signal?: AbortSignal): Promise<OperatorBalance> {
  const res = await authedFetch('/v1/operators/me/balance', { signal });
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
  /** De esta noche, lo que aún no le han pagado (un API antiguo no lo manda). */
  unpaidCents?: number;
  /** Ganado en otras noches y aún sin pagar, sin restar deudas (un API antiguo no lo manda). */
  otherUnpaidCents?: number;
  /** «Copa con invitación»: las copas a las que la invitaron esta noche y su parte (un API antiguo no lo manda). */
  invitations?: { count: number; shareCents: number };
}

export async function fetchMyNight(signal?: AbortSignal): Promise<MyNight> {
  const res = await authedFetch('/v1/nights/mine', { signal });
  if (!res.ok) throw loadError(res, 'Error cargando tu noche');
  return res.json();
}

/** Días de espera, su cuenta de cobro (enmascarada) y sus deudas por devoluciones. */
export async function fetchMyPayoutInfo(): Promise<MyPayoutInfo> {
  const res = await authedFetch('/v1/operators/me/payout-info');
  if (!res.ok) throw loadError(res, 'Error cargando tus pagos');
  return res.json();
}

export async function fetchMyEarnings(): Promise<MyEarning[]> {
  const res = await authedFetch('/v1/operators/me/earnings');
  if (!res.ok) throw loadError(res, 'Error cargando ganancias');
  return res.json();
}

export async function fetchMyPayments(signal?: AbortSignal): Promise<MyPayment[]> {
  const res = await authedFetch('/v1/operators/me/payments', { signal });
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
  /** Recepción: recargar un saldo que ya existe (el de la ficha que acerca). */
  walletId?: string;
  /** Recepción: un saldo nuevo sin etiqueta. */
  newWallet?: boolean;
  /** POS — el camarero confirma tras procesar tarjeta en datáfono externo. */
  captureMethod?: 'QR' | 'POS_EXTERNAL';
  /** Sección del importe tecleado (CHICA_SERVICE, VENUE_BAR…); sin ella, la del puesto. */
  revenueCategory?: SectionCode;
  /** Fase 1A — servicio de la carta: el servidor usa su precio y su categoría. */
  serviceItemId?: string;
  /** «Copa con invitación»: el QR de la chica invitada (lo que se leyó). */
  invitedStaffToken?: string;
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
  } else if (input.walletId) {
    body.wallet = { walletId: input.walletId };
  } else if (input.newWallet) {
    body.wallet = { create: true };
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
  if (input.invitedStaffToken) {
    body.invitedStaffToken = input.invitedStaffToken;
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

export async function fetchPendingPos(zone?: string, signal?: AbortSignal): Promise<PendingPosPayment[]> {
  const qs = zone ? `?zone=${encodeURIComponent(zone)}` : '';
  const res = await authedFetch(`/v1/payments/pending-pos${qs}`, { signal });
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

/**
 * Estado de un cobro por su QR (la misma consulta pública que hace la página
 * del cliente). Respaldo del tiempo real: si el socket se cae, el «pagado» se
 * ve igual.
 */
export async function fetchPaymentStatus(
  qrToken: string,
  signal?: AbortSignal,
): Promise<PolledPayment> {
  const res = await publicFetch(`/v1/payments/public/${encodeURIComponent(qrToken)}`, { cache: 'no-store', signal });
  if (!res.ok) throw loadError(res, 'No se pudo consultar el cobro');
  return res.json();
}

export async function cancelPayment(id: string): Promise<{ status: string }> {
  const res = await authedFetch(`/v1/payments/${id}/cancel`, { method: 'POST' });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Cancelación'));
  return res.json();
}

/** «Mi QR» de la chica: firmado y de vida corta (la app lo renueva). */
export async function fetchMyStaffQr(signal?: AbortSignal): Promise<StaffQrView> {
  const res = await authedFetch('/v1/operators/me/staff-qr', { signal });
  if (!res.ok) throw loadError(res, 'No se pudo sacar tu QR');
  return res.json();
}

/** Secciones del local y la de quien cobra (su puesto): «Otro importe» la marca. */
export interface MySections {
  sections: VenueSection[];
  defaultCategory: SectionCode | null;
  /** Lo que su puesto puede cobrar (null: el API anterior, que no lo dice). */
  allowed: SectionCode[] | null;
  /** Su puesto (Barra, Sala…; null: dueño o encargado sin puesto). */
  post?: PostCode | null;
  /** Su puesto lleva propinas (null: el API anterior). */
  tips?: boolean | null;
}

export async function fetchMySections(): Promise<MySections> {
  const res = await authedFetch('/v1/venues/me');
  if (!res.ok) throw loadError(res, 'Error cargando el local');
  const body = (await res.json()) as {
    sections?: VenueSection[];
    myDefaultCategory?: SectionCode;
    myPost?: PostCode | null;
    myRights?: { sections?: SectionCode[]; tips?: boolean };
  };
  return {
    sections: body.sections ?? [],
    defaultCategory: body.myDefaultCategory ?? null,
    allowed: body.myRights?.sections ?? null,
    post: body.myPost ?? null,
    tips: typeof body.myRights?.tips === 'boolean' ? body.myRights.tips : null,
  };
}

/**
 * Formas de cobro y ajustes de la noche del local (Ajustes del dueño): las
 * apps esconden lo apagado y usan el teclado del PIN y la recepción que tocan.
 * Y el puesto de quien entra y lo que puede (cargar saldos, efectivo): la
 * recepción solo sale a quien la puede hacer.
 */
export async function fetchVenueFeed(): Promise<{ paymentMethods: unknown; nightSettings: unknown; myPost: unknown; myRights: unknown }> {
  const res = await authedFetch('/v1/venues/me');
  if (!res.ok) throw loadError(res, 'Error cargando el local');
  const venue = (await res.json()) as { paymentMethods?: unknown; nightSettings?: unknown; myPost?: unknown; myRights?: unknown };
  return {
    paymentMethods: venue.paymentMethods ?? null,
    nightSettings: venue.nightSettings ?? null,
    myPost: venue.myPost ?? null,
    myRights: venue.myRights ?? null,
  };
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
  category: SectionCode | 'EXTRA';
  /** Pack: sus partes (cada una a su sección). */
  components?: Array<{ category: SectionCode; amountCents: number }> | null;
  /** «Copa con invitación»: hace falta el QR de la chica invitada. */
  isInvitation?: boolean;
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
  /** Puede pagar sin sacar el móvil, con su PIN. */
  hasPin: boolean;
  /** 5 PIN fallidos: hasta que lo desbloquee el encargado. */
  pinLocked: boolean;
  /** Tiene ficha NFC. */
  hasCard: boolean;
}

/**
 * Cómo se dice cuál es el saldo sin el móvil del cliente: su código, su ficha
 * o el QR de su pase de Google Wallet (solo el de cobrar, /c/<token>).
 */
export type WalletRef = { code: string } | { card: string; uid?: string | null } | { walletToken: string };

/** El pase escaneado para un cobro, antes del PIN: ni su saldo ni su código entero. */
export interface WalletPassCheck {
  /** "K7Q-•••". */
  codeHint: string;
  hasPin: boolean;
  pinLocked: boolean;
  /** El PIN lo puso quien cobra o quien hizo el cobro: que lo cobre otra persona. */
  ownPin: boolean;
  /** Le llega para este cobro. */
  enough: boolean;
}

/** El QR del pase de Google Wallet del cliente → de quién es, para este cobro. */
export async function checkWalletPass(chargeId: string, walletToken: string): Promise<WalletPassCheck> {
  const res = await authedFetch(`/v1/wallet-charges/${encodeURIComponent(chargeId)}/pass`, {
    method: 'POST',
    body: JSON.stringify({ walletToken }),
  });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Pase del saldo'));
  return res.json();
}

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
  /** Referencia corta (C-0001). */
  ref?: string | null;
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
  /** Sección del importe tecleado; sin ella, la del puesto. */
  category?: SectionCode;
  /** «Copa con invitación»: el QR de la chica invitada. */
  invitedStaffToken?: string;
}): Promise<QrWalletCharge> {
  const res = await authedFetch('/v1/wallet-charges/qr', { method: 'POST', body: JSON.stringify(input) });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Cobro del saldo'));
  return res.json();
}

export async function fetchWalletCharge(id: string, signal?: AbortSignal): Promise<WalletChargeRequest> {
  const res = await authedFetch(`/v1/wallet-charges/${encodeURIComponent(id)}`, { signal });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Cobro del saldo'));
  return res.json();
}

export async function cancelWalletCharge(id: string): Promise<void> {
  const res = await authedFetch(`/v1/wallet-charges/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Cancelar cobro'));
}

// ─── Public — Self-onboarding ─────────────────────────────────────

/** Petición sin sesión (enlaces de alta e invitación): sin red, un mensaje claro. */
function publicFetch(path: string, init?: RequestInit): Promise<Response> {
  return client.publicFetch(path, init);
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
  /** false: la forma de cobro no se cambia desde el enlace (la pone el admin). Sin el campo, sí. */
  canSetPayout?: boolean;
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

/**
 * El enlace de alta ya se usó para guardar (es de un solo uso): la respuesta
 * pudo perderse, pero los datos están guardados. No es «Link inválido».
 */
export class SelfOnboardingSavedError extends Error {}

/** Error del enlace de alta: caducado o rehecho (401), ya usado para guardar (409) o el de siempre. */
async function selfOnboardingError(res: Response, context: string, expiredText: string): Promise<Error> {
  if (res.status === 401) return new Error(expiredText);
  const text = await res.text().catch(() => '');
  const { message, code } = parseProblemDetails(text);
  if (res.status === 409 && code === SELF_ONBOARDING_ALREADY_SAVED) {
    return new SelfOnboardingSavedError(message ?? 'Tus datos ya se guardaron con este enlace.');
  }
  return new Error(operatorErrorMessage(res.status, message ?? undefined, context, code));
}

export async function fetchSelfOnboardingProfile(token: string): Promise<SelfOnboardingProfile> {
  const res = await publicFetch(`/v1/operators/self-onboarding/${encodeURIComponent(token)}`);
  if (!res.ok) throw await selfOnboardingError(res, 'Onboarding', 'El link expiró o no es válido. Pide uno nuevo al admin.');
  return res.json();
}

export async function submitSelfOnboarding(
  token: string,
  dto: SelfOnboardingSubmitDto,
): Promise<{ ok: true; /** Se guardó todo menos la forma de cobro. */ payoutIgnored?: boolean }> {
  const res = await publicFetch(`/v1/operators/self-onboarding/${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dto),
  });
  if (!res.ok) throw await selfOnboardingError(res, 'Guardado', 'El link expiró. Pide uno nuevo al admin.');
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

// ─── Recepción (camarero, encargado o dueño) ─────────────────────────

/** Qué se puede en la recepción de este local (tarjeta, efectivo, fichas). */
export async function fetchReceptionOptions(): Promise<ReceptionOptions> {
  const res = await authedFetch('/v1/reception/options');
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Recepción'));
  return res.json();
}

/** Recarga en efectivo: sumada al momento (permiso «cobrar recargas en efectivo»). */
export async function receptionCashTopUp(body: CashTopUpDto): Promise<CashTopUpResult> {
  const res = await authedFetch('/v1/reception/cash', { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Recarga en efectivo'));
  return res.json();
}

/** La ficha acercada para recargar: de qué saldo es (sin enseñarlo). */
export async function receptionLookupCard(
  card: string,
  uid: string | null,
): Promise<{ walletId: string; codeHint: string; hasPin: boolean; isHomeVenue: boolean }> {
  const res = await authedFetch('/v1/reception/lookup', { method: 'POST', body: JSON.stringify({ card, ...(uid ? { uid } : {}) }) });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Ficha'));
  return res.json();
}

/** «Preparar fichas»: código nuevo para la próxima ficha en blanco. */
export async function receptionFichaToken(): Promise<string> {
  const res = await authedFetch('/v1/reception/fichas/token', { method: 'POST' });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Ficha'));
  return ((await res.json()) as { card: string }).card;
}

/** «Preparar fichas»: la ficha acercada, al stock del local (o por qué se aparta). */
export async function receptionFichaStock(card: string, uid: string | null): Promise<StockOutcome> {
  const res = await authedFetch('/v1/reception/fichas/stock', { method: 'POST', body: JSON.stringify({ card, ...(uid ? { uid } : {}) }) });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Ficha'));
  return res.json();
}


export async function receptionFichaNumber(card: string, uid: string, printedNumber: string): Promise<{ printedNumber: string }> {
  const res = await authedFetch('/v1/reception/fichas/number', { method: 'POST', body: JSON.stringify({ card, uid, printedNumber }) });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Ficha'));
  return res.json();
}

