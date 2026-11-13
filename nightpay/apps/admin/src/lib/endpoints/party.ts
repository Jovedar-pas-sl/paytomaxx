// OxioParty: el panel del organizador. En directo y la liquidación
// (/v1/party/*), y las casetas, su personal y los ajustes de la fiesta
// (/v1/admin/party/*). Con el panel de OxioPay no se usan (el API da 404).

import type {
  AssignStallDto,
  CreateStallDto,
  PartyLive,
  PartyLiveScope,
  PartySettings,
  PartySettlement,
  StallStaffPerson,
  StallView,
  UpdatePartySettingsDto,
  UpdateStallDto,
} from '@nightpay/contracts';
import { apiError, authedFetch, totpAwareError } from '../http';

const ADMIN = '/v1/admin/party';
const id = (value: string): string => encodeURIComponent(value);

async function json<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await authedFetch(path, { signal });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as T;
}

/** Con el código 2FA si lo trae (cambiar la parte del organizador, el IBAN o la fiesta). */
async function send<T>(path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown): Promise<T> {
  const res = await authedFetch(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!res.ok) throw await totpAwareError(res);
  return (await res.json()) as T;
}

// ─── En directo ─────────────────────────────────────────────────────

export interface PartyLiveRequest {
  scope: PartyLiveScope;
  /** Una noche concreta (AAAA-MM-DD); sin ella, la de ahora. */
  night?: string;
  idleMin?: number;
}

export function partyLiveQuery(q: PartyLiveRequest): string {
  const qs = new URLSearchParams({ scope: q.scope });
  if (q.scope === 'night' && q.night) qs.set('night', q.night);
  if (q.idleMin !== undefined) qs.set('idleMin', String(q.idleMin));
  return `?${qs.toString()}`;
}

export function fetchPartyLive(q: PartyLiveRequest, signal?: AbortSignal): Promise<PartyLive> {
  return json(`/v1/party/live${partyLiveQuery(q)}`, signal);
}

// ─── Casetas y su personal ──────────────────────────────────────────

export function fetchStalls(signal?: AbortSignal): Promise<StallView[]> {
  return json(`${ADMIN}/stalls`, signal);
}

export function createStall(dto: CreateStallDto): Promise<StallView> {
  return send(`${ADMIN}/stalls`, 'POST', dto);
}

export function updateStall(stallId: string, dto: UpdateStallDto): Promise<StallView> {
  return send(`${ADMIN}/stalls/${id(stallId)}`, 'PATCH', dto);
}

/** Solo una sin cobros (con cobros: 409 STALL_IN_USE, se desactiva). */
export function deleteStall(stallId: string): Promise<{ deleted: true; unassignedStaff: number }> {
  return send(`${ADMIN}/stalls/${id(stallId)}`, 'DELETE');
}

export function fetchStallStaff(signal?: AbortSignal): Promise<StallStaffPerson[]> {
  return json(`${ADMIN}/staff`, signal);
}

export function assignStall(userId: string, dto: AssignStallDto): Promise<StallStaffPerson> {
  return send(`${ADMIN}/staff/${id(userId)}`, 'PATCH', dto);
}

// ─── La fiesta ──────────────────────────────────────────────────────

export function fetchPartySettings(signal?: AbortSignal): Promise<PartySettings> {
  return json(`${ADMIN}/settings`, signal);
}

export function updatePartySettings(dto: UpdatePartySettingsDto): Promise<PartySettings> {
  return send(`${ADMIN}/settings`, 'PATCH', dto);
}

// ─── Cierre: lo que se paga a cada caseta ───────────────────────────

/** Unas noches (AAAA-MM-DD, de la primera a la última) o, sin ellas, la fiesta entera. */
export interface PartyRange {
  from?: string;
  to?: string;
}

export function partyRangeQuery(r: PartyRange): string {
  return r.from && r.to ? `?${new URLSearchParams({ from: r.from, to: r.to }).toString()}` : '';
}

export function fetchPartySettlement(r: PartyRange, signal?: AbortSignal): Promise<PartySettlement> {
  return json(`/v1/party/settlement${partyRangeQuery(r)}`, signal);
}

/** El fichero del banco (SEPA, XML) o el CSV, como archivo. */
export async function downloadPartySettlement(kind: 'sepa' | 'csv', r: PartyRange): Promise<Blob> {
  const res = await authedFetch(`/v1/party/settlement/${kind}${partyRangeQuery(r)}`);
  if (!res.ok) throw await apiError(res);
  return res.blob();
}
