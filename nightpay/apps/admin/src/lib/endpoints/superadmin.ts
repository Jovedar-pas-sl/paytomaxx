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
  PayoutAccountFull,
  PayoutAccountListItem,
  ResetStaffPasswordResponse,
  RevokeSessionsResponse,
  StaffUserPage,
  StaffUserView,
  SuperAdminOverview,
  UpdateBusinessDto,
  VenueDetail,
  VenueListItem,
} from '@nightpay/contracts';
import { ApiError } from '../api-errors';
import { API_BASE, authedFetch, totpAwareError } from '../http';
import { absoluteApiUrl } from '../superadmin/labels';
import type { ProfileDto, RulesDto } from '../superadmin/forms';
import type { NewPersonDto, PayoutUpdateDto } from '../superadmin/person-forms';

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

export function createSaBusiness(dto: CreateBusinessDto): Promise<BusinessView> {
  return post('/businesses', dto);
}

export function updateSaBusiness(businessId: string, dto: UpdateBusinessDto): Promise<BusinessView> {
  return patch(`/businesses/${id(businessId)}`, dto);
}

export function pauseSaBusiness(businessId: string, input: StepUpInput): Promise<BusinessView> {
  return post(`/businesses/${id(businessId)}/pause`, input);
}

export function resumeSaBusiness(businessId: string, input: StepUpInput): Promise<BusinessView> {
  return post(`/businesses/${id(businessId)}/resume`, input);
}

export function assignSaVenues(businessId: string, venueIds: string[]): Promise<BusinessDetail> {
  return post(`/businesses/${id(businessId)}/venues`, { venueIds });
}

export function unassignSaVenue(businessId: string, venueId: string): Promise<BusinessDetail> {
  return post(`/businesses/${id(businessId)}/venues/${id(venueId)}/unassign`);
}

// ─── Locales ────────────────────────────────────────────────────────

export function fetchSaVenues(query = '', signal?: AbortSignal): Promise<VenueListItem[]> {
  return call(`/venues${query}`, { signal });
}

export function fetchSaVenue(venueId: string, signal?: AbortSignal): Promise<VenueDetail> {
  return call(`/venues/${id(venueId)}`, { signal });
}

export function createSaVenue(dto: CreateVenueDto): Promise<VenueDetail> {
  return post('/venues', dto);
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

export function pauseSaVenue(venueId: string, input: StepUpInput): Promise<VenueDetail> {
  return post(`/venues/${id(venueId)}/pause`, input);
}

export function resumeSaVenue(venueId: string, input: StepUpInput): Promise<VenueDetail> {
  return post(`/venues/${id(venueId)}/resume`, input);
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
