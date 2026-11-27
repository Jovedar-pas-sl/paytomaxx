// El mapa del dinero: lista de cobros (con su chica, sección, cómo pagó y
// saldo), ficha del saldo, secciones del local y puestos del personal.

import type {
  ChargeMethod,
  CobrosPage,
  InvitationRules,
  InvitationSummary,
  MoneyMap,
  StaffFicha,
  UpdateInvitationRulesDto,
  PostCode,
  PostRules,
  PuestoPerson,
  UpdatePostRulesDto,
  UpdateSectionsDto,
  VenueSection,
  WalletFicha,
} from '@nightpay/contracts';
import { apiError, authedFetch } from '../http';

export interface CobrosFilters {
  operatorId?: string;
  /** Sección (o EXTRA: los antiguos sin sección). */
  category?: string;
  method?: ChargeMethod;
  walletCode?: string;
  search?: string;
  walletId?: string;
  /** Las invitaciones a esta chica («Copa con invitación»). */
  invitedOperatorId?: string;
  nightId?: string;
  status?: string[];
  /** Ventana de una cifra del mapa del dinero: instantes ISO, [from, to). */
  from?: string;
  to?: string;
}

export function cobrosQuery(filters: CobrosFilters, page: { cursor?: string; limit?: number } = {}): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    qs.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  if (page.cursor) qs.set('cursor', page.cursor);
  if (page.limit) qs.set('limit', String(page.limit));
  return qs.toString();
}

export async function fetchCobros(filters: CobrosFilters, page: { cursor?: string; limit?: number } = {}, signal?: AbortSignal): Promise<CobrosPage> {
  const res = await authedFetch(`/v1/admin/cobros?${cobrosQuery(filters, page)}`, signal ? { signal } : undefined);
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/**
 * El mapa del dinero: la noche en directo (sin nada), una noche (su Z,
 * congelado al cerrar), unas fechas (días de Madrid) o varias noches por
 * instantes (fromAt y, si la más nueva ya cerró, toAt).
 */
export async function fetchMoneyMap(
  q: { night?: string; from?: string; to?: string; fromAt?: string; toAt?: string } = {},
  signal?: AbortSignal,
): Promise<MoneyMap> {
  const qs = new URLSearchParams();
  if (q.night) qs.set('night', q.night);
  if (q.from && q.to) {
    qs.set('from', q.from);
    qs.set('to', q.to);
  }
  if (q.fromAt) {
    qs.set('fromAt', q.fromAt);
    if (q.toAt) qs.set('toAt', q.toAt);
  }
  const query = qs.toString();
  const res = await authedFetch(`/v1/admin/money-map${query ? `?${query}` : ''}`, { signal });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/** Ficha de la chica o del camarero: esta noche, sus cobros con su parte, lo vendido, lo suyo y lo pagado. */
export async function fetchStaffFicha(personId: string): Promise<StaffFicha> {
  const res = await authedFetch(`/v1/admin/operators/${encodeURIComponent(personId)}/ficha`);
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function fetchWalletFicha(walletId: string): Promise<WalletFicha> {
  const res = await authedFetch(`/v1/admin/wallets/${encodeURIComponent(walletId)}/ficha`);
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function fetchSections(): Promise<VenueSection[]> {
  const res = await authedFetch('/v1/admin/venue/sections');
  if (!res.ok) throw await apiError(res);
  return ((await res.json()) as { sections: VenueSection[] }).sections;
}

export async function updateSections(patch: UpdateSectionsDto): Promise<VenueSection[]> {
  const res = await authedFetch('/v1/admin/venue/sections', { method: 'PATCH', body: JSON.stringify(patch) });
  if (!res.ok) throw await apiError(res);
  return ((await res.json()) as { sections: VenueSection[] }).sections;
}

export async function fetchPuestos(): Promise<PuestoPerson[]> {
  const res = await authedFetch('/v1/admin/venue/puestos');
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function updatePuesto(userId: string, post: PostCode | null): Promise<PuestoPerson> {
  const res = await authedFetch(`/v1/admin/venue/puestos/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ post }),
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function fetchPostRules(): Promise<PostRules> {
  const res = await authedFetch('/v1/admin/venue/post-rules');
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function updatePostRules(patch: UpdatePostRulesDto): Promise<PostRules> {
  const res = await authedFetch('/v1/admin/venue/post-rules', { method: 'PATCH', body: JSON.stringify(patch) });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function fetchInvitationRules(): Promise<InvitationRules> {
  const res = await authedFetch('/v1/admin/venue/invitation-rules');
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function updateInvitationRules(patch: UpdateInvitationRulesDto): Promise<InvitationRules> {
  const res = await authedFetch('/v1/admin/venue/invitation-rules', { method: 'PATCH', body: JSON.stringify(patch) });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/** Las invitaciones a una chica: cuántas, cuánto y su parte. */
export async function fetchInvitationSummary(operatorId: string): Promise<InvitationSummary> {
  const res = await authedFetch(`/v1/admin/operators/${encodeURIComponent(operatorId)}/invitaciones`);
  if (!res.ok) throw await apiError(res);
  return res.json();
}
