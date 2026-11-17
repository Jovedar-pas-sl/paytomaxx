// Ajustes del local: reglas (con 2FA), formas de cobro, la noche, permisos del personal y avisos de Telegram.

import type {
  BtcpaySettingsView,
  BtcpayTestResult,
  CustomerDisplayMessage,
  CustomerDisplayMessageSettings,
  PermissionSet,
  SaveBtcpaySettingsDto,
  TestBtcpaySettingsDto,
  UpdateBtcpayModeDto,
  StaffPermissions,
  UpdateAlertSettingsDto,
  UpdateNightSettingsDto,
  UpdatePaymentMethodsDto,
  UpdateStaffPermissionsDto,
  VenueAlertSettings,
  VenueNightSettings,
  VenuePaymentMethods,
} from '@nightpay/contracts';
import { apiError, authedFetch, totpAwareError } from '../http';

// ─── Venue settings (Ajustes → Reglas del local) ───────────────────

export interface OperatorCommissionDefaults {
  CHICA_SERVICE: number;
  VENUE_BAR: number;
  VENUE_ROOM: number;
  VENUE_FOOD: number;
  /** Entradas (sección nueva): los locales de antes no la tienen guardada (0 %). */
  VENUE_ENTRY?: number;
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
  /** Días de espera para pagar a las chicas (null = los del servidor; 0 = al cierre de la noche). */
  payoutHoldDays?: number | null;
  /** Los que valen de verdad (los del local o los del servidor). */
  effectivePayoutHoldDays?: number;
  refundApprovalThresholdCents?: number;
  payoutRequiresApproval?: boolean;
  /**
   * «Comisión del servicio al cliente» (la pone OxioPay; aquí solo se ve):
   * encendida y sus % (pagos con tarjeta / recargas). Un API de antes no los
   * manda: apagada.
   */
  serviceFeeEnabled?: boolean;
  serviceFeeBps?: number;
  topUpServiceFeeBps?: number;
}

export async function fetchVenueSettings(): Promise<VenueSettings> {
  const res = await authedFetch('/v1/admin/venue/settings');
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export interface VenueRulesInput {
  operatorMaxCobroCents?: number;
  operatorCommissionDefaults?: Partial<OperatorCommissionDefaults>;
  payoutHoldDays?: number | null;
  refundApprovalThresholdCents?: number;
  payoutRequiresApproval?: boolean;
}

/**
 * Las reglas de dinero: con la 2FA activada, con el código (403
 * TOTP_REQUIRED sin él). La comisión de OxioPay no se manda: la cambia solo
 * el super-admin. Devuelve lo guardado (sin nombre ni zona).
 */
export async function updateVenueSettings(input: VenueRulesInput, totpCode?: string): Promise<VenueSettings> {
  const res = await authedFetch('/v1/admin/venue/settings', {
    method: 'PATCH',
    body: JSON.stringify(totpCode ? { ...input, totpCode } : input),
  });
  if (!res.ok) throw await totpAwareError(res);
  return res.json();
}

// ─── Formas de cobro ───────────────────────────────────────────────

export async function fetchPaymentMethods(): Promise<VenuePaymentMethods> {
  const res = await authedFetch('/v1/admin/venue/payment-methods');
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function updatePaymentMethods(input: UpdatePaymentMethodsDto): Promise<VenuePaymentMethods> {
  const res = await authedFetch('/v1/admin/venue/payment-methods', { method: 'PATCH', body: JSON.stringify(input) });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

// ─── Permisos del personal ─────────────────────────────────────────

export interface PermissionPerson {
  id: string;
  email: string;
  displayName: string | null;
  role: 'MANAGER' | 'WAITER';
  /** Huella de su foto de perfil, o null sin foto. */
  photoHash?: string | null;
}

export async function fetchStaffPermissions(): Promise<{ permissions: StaffPermissions; people: PermissionPerson[] }> {
  const res = await authedFetch('/v1/admin/venue/permissions');
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function updateStaffPermissions(input: UpdateStaffPermissionsDto): Promise<StaffPermissions> {
  const res = await authedFetch('/v1/admin/venue/permissions', { method: 'PATCH', body: JSON.stringify(input) });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/** Lo que puede hacer quien mira (el encargado ve los informes si el dueño le deja). */
export async function fetchMyPermissions(): Promise<PermissionSet> {
  const res = await authedFetch('/v1/admin/venue/permissions/me');
  if (!res.ok) throw await apiError(res);
  return res.json();
}

// ─── Avisos de Telegram ────────────────────────────────────────────

export interface AlertSettingsView extends VenueAlertSettings {
  /** Hay bot de Telegram en el servidor. */
  botConfigured: boolean;
  /** Hay chat por defecto para los locales sin chat propio. */
  defaultChatConfigured: boolean;
}

export async function fetchAlertSettings(): Promise<AlertSettingsView> {
  const res = await authedFetch('/v1/admin/venue/alerts');
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function updateAlertSettings(input: UpdateAlertSettingsDto): Promise<AlertSettingsView> {
  const res = await authedFetch('/v1/admin/venue/alerts', { method: 'PATCH', body: JSON.stringify(input) });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

// ─── La noche (NFC sin PIN, teclado del PIN, recepción) ────────────

export async function fetchNightSettings(): Promise<VenueNightSettings> {
  const res = await authedFetch('/v1/admin/venue/night');
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function updateNightSettings(input: UpdateNightSettingsDto): Promise<VenueNightSettings> {
  const res = await authedFetch('/v1/admin/venue/night', { method: 'PATCH', body: JSON.stringify(input) });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

// ─── Pantalla del cliente: el mensaje del reposo (dueño y encargado) ─

export async function fetchDisplayMessage(): Promise<CustomerDisplayMessageSettings> {
  const res = await authedFetch('/v1/customer-display/message');
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function updateDisplayMessage(input: CustomerDisplayMessage): Promise<CustomerDisplayMessageSettings> {
  const res = await authedFetch('/v1/customer-display/message', { method: 'PUT', body: JSON.stringify(input) });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

// ─── Bitcoin (BTCPay) ──────────────────────────────────────────────

/**
 * Lo guardado de la conexión a BTCPay. null = el servidor no tiene el pago con
 * bitcoin encendido (BTCPAY_ENABLED): sus rutas dan 404 y el panel no enseña la sección.
 */
export async function fetchBtcpaySettings(): Promise<BtcpaySettingsView | null> {
  const res = await authedFetch('/v1/admin/venue/btcpay');
  if (res.status === 404) return null;
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/** Guardar o cambiar la conexión (con la 2FA del dueño): prueba la conexión y registra el aviso en BTCPay. */
export async function saveBtcpaySettings(input: SaveBtcpaySettingsDto): Promise<BtcpaySettingsView> {
  const res = await authedFetch('/v1/admin/venue/btcpay', { method: 'PUT', body: JSON.stringify(input) });
  if (!res.ok) throw await totpAwareError(res);
  return res.json();
}

/** Encender o apagar el bitcoin y para qué se usa, con la 2FA. */
export async function updateBtcpayMode(input: UpdateBtcpayModeDto): Promise<BtcpaySettingsView> {
  const res = await authedFetch('/v1/admin/venue/btcpay', { method: 'PATCH', body: JSON.stringify(input) });
  if (!res.ok) throw await totpAwareError(res);
  return res.json();
}

/** «Probar conexión»: lo guardado, o lo que se está escribiendo (sin guardarlo). */
export async function testBtcpaySettings(input: TestBtcpaySettingsDto): Promise<BtcpayTestResult> {
  const res = await authedFetch('/v1/admin/venue/btcpay/test', { method: 'POST', body: JSON.stringify(input) });
  if (!res.ok) throw await apiError(res);
  return res.json();
}
