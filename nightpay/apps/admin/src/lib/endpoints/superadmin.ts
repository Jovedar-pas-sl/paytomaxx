// Consola del super-admin (/v1/superadmin/*, docs/SUPERADMIN.md): todos los
// locales. Las escrituras con 2FA llevan `totpCode` en el cuerpo; los errores
// 2FA salen en castellano y con su código (totpAwareError). Cada llamada tiene
// un tope de tiempo: nada se queda en «Cargando…» para siempre.

import type {
  AuditEventPage,
  BusinessDetail,
  BusinessView,
  CreateBusinessDto,
  CreateStaffUserResponse,
  CreateVenueDto,
  CustomerSearchResult,
  CustomerWalletDetail,
  GenerateSettlementDto,
  OxioPayPayee,
  PartnerApiStateView,
  PartnerFreeze,
  PartnerView,
  SuperAdminPartnerConnectionView,
  SuperAdminPartnersOverview,
  PayoutAccountFull,
  PayoutAccountListItem,
  ResetStaffPasswordResponse,
  RecordSettlementPaymentDto,
  RevokeSessionsResponse,
  SetOxioPayPayeeDto,
  SettlementDetail,
  StaffUserPage,
  StaffUserView,
  SuperAdminOverview,
  SuperAdminSettlementPage,
  UpdateBusinessDto,
  VenueDetail,
  VenueListItem,
  YavinVenueStatus,
} from '@nightpay/contracts';
import { ApiError } from '../api-errors';
import { API_BASE, authedFetch, totpAwareError } from '../http';
import { absoluteApiUrl } from '../superadmin/labels';
import type { ProfileDto, RulesDto } from '../superadmin/forms';
import type { NewPersonDto, PayoutUpdateDto } from '../superadmin/person-forms';
import type { PartnerBody, PartnerChanges } from '../superadmin/partner-forms';

/** Tope de espera de una llamada de la consola. */
const TIMEOUT_MS = 20_000;
const SLOW_MESSAGE = 'El servidor tarda demasiado en responder. Revisa la conexión y vuelve a probar.';

/** Cuerpo de las acciones con 2FA (y motivo, si lo piden). */
export interface StepUpInput {
  totpCode: string;
  reason?: string;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const outer = init.signal ?? null;
  const onOuterAbort = (): void => controller.abort();
  if (outer?.aborted) controller.abort();
  outer?.addEventListener('abort', onOuterAbort);
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await authedFetch(`/v1/superadmin${path}`, { ...init, signal: controller.signal });
    if (!res.ok) throw await totpAwareError(res);
    return (await res.json()) as T;
  } catch (err) {
    // Abortado por quien llama (cambió de pantalla): se deja pasar tal cual.
    if (err instanceof Error && err.name === 'AbortError' && !outer?.aborted) {
      throw new ApiError(SLOW_MESSAGE, 0, 'TIMEOUT');
    }
    throw err;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onOuterAbort);
  }
}

const post = <T>(path: string, body: unknown = {}): Promise<T> =>
  call<T>(path, { method: 'POST', body: JSON.stringify(body) });

/**
 * Cuerpo de una acción con 2FA: el motivo opcional vacío no se manda. Antes
 * «Reanudar» sin motivo mandaba reason: '' y el API (mínimo 3 letras si
 * viene) lo rechazaba con 400: no se podía reanudar un local en pausa.
 */
export function stepUpBody(input: StepUpInput): StepUpInput {
  const reason = input.reason?.trim();
  return reason ? { totpCode: input.totpCode, reason } : { totpCode: input.totpCode };
}
/** El cuerpo con el código 2FA, si lo hay (sin él, tal cual). */
function withCode<T extends object>(dto: T, totpCode: string | undefined): T & { totpCode?: string } {
  return totpCode ? { ...dto, totpCode } : dto;
}
const patch = <T>(path: string, body: unknown): Promise<T> =>
  call<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
const put = <T>(path: string, body: unknown): Promise<T> => call<T>(path, { method: 'PUT', body: JSON.stringify(body) });
const id = (value: string): string => encodeURIComponent(value);

// ─── Vista general y registro ───────────────────────────────────────

export function fetchSaOverview(signal?: AbortSignal): Promise<SuperAdminOverview> {
  return call('/overview', { signal });
}

/** `query` sale de auditQuery (lib/superadmin/query). */
export function fetchSaAudit(query: string, signal?: AbortSignal): Promise<AuditEventPage> {
  return call(`/audit${query}`, { signal });
}

// ─── Negocios ───────────────────────────────────────────────────────

export function fetchSaBusinesses(query = '', signal?: AbortSignal): Promise<BusinessView[]> {
  return call(`/businesses${query}`, { signal });
}

export function fetchSaBusiness(businessId: string, signal?: AbortSignal): Promise<BusinessDetail> {
  return call(`/businesses/${id(businessId)}`, { signal });
}

/** Con una comisión por defecto propia hace falta `totpCode` (businessCreateNeedsStepUp). */
export function createSaBusiness(dto: CreateBusinessDto, totpCode?: string): Promise<BusinessView> {
  return post('/businesses', withCode(dto, totpCode));
}

/** Si cambia la comisión por defecto hace falta `totpCode` (businessUpdateNeedsStepUp). */
export function updateSaBusiness(businessId: string, dto: UpdateBusinessDto, totpCode?: string): Promise<BusinessView> {
  return patch(`/businesses/${id(businessId)}`, withCode(dto, totpCode));
}

export function pauseSaBusiness(businessId: string, input: StepUpInput): Promise<BusinessView> {
  return post(`/businesses/${id(businessId)}/pause`, input);
}

export function resumeSaBusiness(businessId: string, input: StepUpInput): Promise<BusinessView> {
  return post(`/businesses/${id(businessId)}/resume`, stepUpBody(input));
}

/** 2FA: un local que estaba en un negocio en pausa vuelve a cobrar. */
export function assignSaVenues(businessId: string, venueIds: string[], totpCode: string): Promise<BusinessDetail> {
  return post(`/businesses/${id(businessId)}/venues`, { venueIds, totpCode });
}

/** 2FA: si el negocio está en pausa, el local vuelve a cobrar. */
export function unassignSaVenue(businessId: string, venueId: string, totpCode: string): Promise<BusinessDetail> {
  return post(`/businesses/${id(businessId)}/venues/${id(venueId)}/unassign`, { totpCode });
}

// ─── Locales ────────────────────────────────────────────────────────

export function fetchSaVenues(query = '', signal?: AbortSignal): Promise<VenueListItem[]> {
  return call(`/venues${query}`, { signal });
}

export function fetchSaVenue(venueId: string, signal?: AbortSignal): Promise<VenueDetail> {
  return call(`/venues/${id(venueId)}`, { signal });
}

/** Con el grupo del saldo o una comisión propia hace falta `totpCode` (venueCreateNeedsStepUp). */
export function createSaVenue(dto: CreateVenueDto, totpCode?: string): Promise<VenueDetail> {
  return post('/venues', withCode(dto, totpCode));
}

/** Con el grupo del saldo o el IVA hace falta `totpCode`. */
export function updateSaVenueProfile(venueId: string, dto: ProfileDto, totpCode?: string): Promise<VenueDetail> {
  return patch(`/venues/${id(venueId)}/profile`, totpCode ? { ...dto, totpCode } : dto);
}

export function updateSaVenueRules(venueId: string, dto: RulesDto, totpCode: string): Promise<VenueDetail> {
  return patch(`/venues/${id(venueId)}/rules`, { ...dto, totpCode });
}

export function setSaSettlementAccount(
  venueId: string,
  input: { iban: string; holder: string; totpCode: string },
): Promise<VenueDetail> {
  return put(`/venues/${id(venueId)}/settlement-account`, input);
}

export function clearSaSettlementAccount(venueId: string, input: StepUpInput): Promise<VenueDetail> {
  return post(`/venues/${id(venueId)}/settlement-account/clear`, input);
}

// ─── Yavin en un local (solo con YAVIN_ENABLED en el servidor: si no, 404) ───

/** null = el servidor no tiene Yavin encendido (la tarjeta no sale). */
export async function fetchSaYavin(venueId: string, signal?: AbortSignal): Promise<YavinVenueStatus | null> {
  try {
    return await call<YavinVenueStatus>(`/venues/${id(venueId)}/yavin`, { signal });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** La clave va solo en esta petición: el API nunca la devuelve. */
export function setSaYavinKey(venueId: string, input: { apiKey: string; totpCode: string }): Promise<YavinVenueStatus> {
  return put(`/venues/${id(venueId)}/yavin/key`, input);
}

export function setSaYavinUse(venueId: string, input: { use: boolean; totpCode: string }): Promise<YavinVenueStatus> {
  return post(`/venues/${id(venueId)}/yavin/use`, input);
}

export function clearSaYavin(venueId: string, input: StepUpInput): Promise<YavinVenueStatus> {
  return post(`/venues/${id(venueId)}/yavin/clear`, input);
}

export function pauseSaVenue(venueId: string, input: StepUpInput): Promise<VenueDetail> {
  return post(`/venues/${id(venueId)}/pause`, input);
}

export function resumeSaVenue(venueId: string, input: StepUpInput): Promise<VenueDetail> {
  return post(`/venues/${id(venueId)}/resume`, stepUpBody(input));
}

// ─── Personas ───────────────────────────────────────────────────────

/** `query` sale de staffQuery (lib/superadmin/query). */
export function fetchSaUsers(query: string, signal?: AbortSignal): Promise<StaffUserPage> {
  return call(`/users${query}`, { signal });
}

export function createSaUser(dto: NewPersonDto, totpCode: string): Promise<CreateStaffUserResponse> {
  return post('/users', { ...dto, totpCode });
}

export function resetSaUserPassword(userId: string, input: StepUpInput): Promise<ResetStaffPasswordResponse> {
  return post(`/users/${id(userId)}/reset-password`, input);
}

export function disableSaUser(userId: string, input: StepUpInput): Promise<StaffUserView> {
  return post(`/users/${id(userId)}/disable`, input);
}

export function enableSaUser(userId: string, input: StepUpInput): Promise<StaffUserView> {
  return post(`/users/${id(userId)}/enable`, input);
}

export function revokeSaUserSessions(userId: string, reason: string): Promise<RevokeSessionsResponse> {
  return post(`/users/${id(userId)}/revoke-sessions`, { reason });
}

export function resetSaUserTotp(userId: string, input: StepUpInput): Promise<StaffUserView> {
  return post(`/users/${id(userId)}/totp/reset`, input);
}

/** 409 si dejaría la plataforma sin super-admins. */
export function setSaSuperAdmin(userId: string, enabled: boolean, input: StepUpInput): Promise<StaffUserView> {
  return post(`/users/${id(userId)}/super-admin`, { enabled, ...input });
}

// ─── Cuentas de cobro de las chicas ─────────────────────────────────

export function fetchSaPayoutAccounts(query = '', signal?: AbortSignal): Promise<PayoutAccountListItem[]> {
  return call(`/payout-accounts${query}`, { signal });
}

export function revealSaPayoutAccount(userId: string, input: StepUpInput): Promise<PayoutAccountFull> {
  return post(`/payout-accounts/${id(userId)}/reveal`, input);
}

export function updateSaPayoutAccount(
  userId: string,
  dto: PayoutUpdateDto,
  input: StepUpInput,
): Promise<PayoutAccountListItem> {
  return put(`/payout-accounts/${id(userId)}`, { ...dto, ...input });
}

// ─── Clientes con saldo ─────────────────────────────────────────────

export function searchSaCustomers(q: string, signal?: AbortSignal): Promise<CustomerSearchResult[]> {
  return call(`/customers/search?q=${encodeURIComponent(q.trim())}`, { signal });
}

export function fetchSaCustomer(walletId: string, signal?: AbortSignal): Promise<CustomerWalletDetail> {
  return call(`/customers/${id(walletId)}`, { signal });
}

export function blockSaCustomer(walletId: string, reason: string): Promise<CustomerWalletDetail> {
  return post(`/customers/${id(walletId)}/block`, { reason });
}

export function unblockSaCustomer(walletId: string, input: StepUpInput): Promise<CustomerWalletDetail> {
  return post(`/customers/${id(walletId)}/unblock`, input);
}

export function unlockSaCustomerPin(walletId: string, input: StepUpInput): Promise<CustomerWalletDetail> {
  return post(`/customers/${id(walletId)}/unlock-pin`, input);
}

/** Enlace nuevo del saldo: la ruta del API y el enlace completo (es la llave del cliente). */
export async function relinkSaCustomer(
  walletId: string,
  input: StepUpInput,
): Promise<{ url: string; removedPasskeys: number }> {
  const res = await post<{ path: string; removedPasskeys?: number }>(`/customers/${id(walletId)}/relink`, input);
  return { url: absoluteApiUrl(API_BASE, res.path), removedPasskeys: res.removedPasskeys ?? 0 };
}

// ─── Liquidaciones OxioPay ──────────────────────────────────────────

/** `query` sale de settlementsQuery (lib/oxiopay-settlements). */
export function fetchSaSettlements(query: string, signal?: AbortSignal): Promise<SuperAdminSettlementPage> {
  return call(`/oxiopay-settlements${query}`, { signal });
}

export function fetchSaSettlement(settlementId: string, signal?: AbortSignal): Promise<SettlementDetail> {
  return call(`/oxiopay-settlements/${id(settlementId)}`, { signal });
}

/** Lo recibido por transferencia (2FA; motivo si no es lo pendiente). */
export function recordSaSettlementPayment(settlementId: string, dto: RecordSettlementPaymentDto): Promise<SettlementDetail> {
  return post(`/oxiopay-settlements/${id(settlementId)}/payments`, dto);
}

/** Anular (solo sin pagos; 2FA y motivo). */
export function voidSaSettlement(settlementId: string, input: StepUpInput): Promise<SettlementDetail> {
  return post(`/oxiopay-settlements/${id(settlementId)}/void`, input);
}

/** Generar (o regenerar tras anularla) la de un local y una semana ya terminada. */
export function generateSaSettlement(dto: GenerateSettlementDto): Promise<SettlementDetail> {
  return post('/oxiopay-settlements/generate', dto);
}

/** La semana de inicio de las liquidaciones (lunes AAAA-MM-DD; null si aún no está fijada). */
export function fetchSaSettlementSettings(signal?: AbortSignal): Promise<{ startWeek: string | null }> {
  return call('/oxiopay-settlements/settings', { signal });
}

/** Cambiarla (2FA y motivo). */
export function setSaSettlementStart(input: { startWeek: string; reason: string; totpCode: string }): Promise<{ startWeek: string }> {
  return put('/oxiopay-settlements/settings', input);
}

export async function fetchSaPayee(signal?: AbortSignal): Promise<OxioPayPayee | null> {
  return (await call<{ payee: OxioPayPayee | null }>('/oxiopay-settlements/payee', { signal })).payee;
}

export async function setSaPayee(dto: SetOxioPayPayeeDto): Promise<OxioPayPayee> {
  return (await put<{ payee: OxioPayPayee }>('/oxiopay-settlements/payee', dto)).payee;
}

/** El documento (HTML para imprimir / PDF) o el CSV de una liquidación, como archivo. */
export async function downloadSaSettlement(settlementId: string, kind: 'document' | 'csv'): Promise<Blob> {
  const res = await authedFetch(`/v1/superadmin/oxiopay-settlements/${id(settlementId)}/${kind}`);
  if (!res.ok) throw await totpAwareError(res);
  return res.blob();
}

// ─── Socios (API de socios): registro, conexiones y congelación ─────────

export function fetchSaPartners(signal?: AbortSignal): Promise<SuperAdminPartnersOverview> {
  return call('/partners', { signal });
}

/** Alta (siempre con 2FA). */
export function createSaPartner(dto: PartnerBody, totpCode: string): Promise<PartnerView> {
  return post('/partners', { ...dto, totpCode });
}

/** Editar: con 2FA si cambian permisos, IP, KYB o el contrato de datos. */
export function updateSaPartner(partnerId: string, changes: PartnerChanges, totpCode?: string): Promise<PartnerView> {
  return patch(`/partners/${id(partnerId)}`, withCode(changes, totpCode));
}

export function suspendSaPartner(partnerId: string, input: StepUpInput): Promise<PartnerView> {
  return post(`/partners/${id(partnerId)}/suspend`, stepUpBody(input));
}

export function resumeSaPartner(partnerId: string, input: StepUpInput): Promise<PartnerView> {
  return post(`/partners/${id(partnerId)}/resume`, stepUpBody(input));
}

/** Pausar una conexión (queda «En pausa por OxioPay»): solo el motivo. */
export function pauseSaPartnerConnection(connectionId: string, reason: string): Promise<SuperAdminPartnerConnectionView> {
  return post(`/partners/connections/${id(connectionId)}/pause`, { reason });
}

export function resumeSaPartnerConnection(connectionId: string, input: StepUpInput): Promise<SuperAdminPartnerConnectionView> {
  return post(`/partners/connections/${id(connectionId)}/resume`, stepUpBody(input));
}

export function revokeSaPartnerConnection(connectionId: string, input: StepUpInput): Promise<SuperAdminPartnerConnectionView> {
  return post(`/partners/connections/${id(connectionId)}/revoke`, stepUpBody(input));
}

/** Congelar o descongelar la API (2FA y motivo). */
export function setSaPartnerFreeze(freeze: PartnerFreeze, input: StepUpInput): Promise<PartnerApiStateView> {
  return put('/partners/api-state', { freeze, reason: input.reason ?? '', totpCode: input.totpCode });
}
