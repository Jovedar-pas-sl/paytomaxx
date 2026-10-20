// Ajustes del local: reglas (con 2FA), formas de cobro, la noche, permisos del personal y avisos de Telegram.

import type {
  PermissionSet,
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
