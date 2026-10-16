// Filtros de la consola del super-admin → query string de /v1/superadmin/*.
// Lo vacío no se manda (el API lo toma como «todos»).

import type { BusinessStatusValue, Role } from '@nightpay/contracts';
import { MADRID_TIMEZONE } from '../dates';

type QueryValue = string | number | boolean | null | undefined;

/** {a: 'x', b: '', c: true} → "?a=x&c=true". Sin nada que mandar → "". */
export function toQueryString(params: Readonly<Record<string, QueryValue>>): string {
  const search = new URLSearchParams();
  for (const [key, raw] of Object.entries(params)) {
    if (raw === null || raw === undefined) continue;
    const value = typeof raw === 'string' ? raw.trim() : String(raw);
    if (value === '') continue;
    search.set(key, value);
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/** Páginas de la consola (personas y registro). */
export const SA_PAGE_SIZE = 50;

// ─── Negocios y locales ─────────────────────────────────────────────

export interface BusinessFilters {
  q: string;
  status: BusinessStatusValue | '';
}

export function businessesQuery(f: BusinessFilters): string {
  return toQueryString({ q: f.q, status: f.status });
}

export interface VenueFilters {
  q: string;
  businessId: string;
  /** '' = todos; 'paused' = solo en pausa; 'active' = solo los que cobran. */
  state: '' | 'paused' | 'active';
}

export function venuesQuery(f: VenueFilters): string {
  const paused = f.state === 'paused' ? 'true' : f.state === 'active' ? 'false' : undefined;
  return toQueryString({ q: f.q, businessId: f.businessId, paused });
}

// ─── Personas ───────────────────────────────────────────────────────

export interface StaffFilters {
  venueId: string;
  role: Role | '';
  q: string;
  /** '' = todas; 'active' = de alta; 'inactive' = dadas de baja. */
  state: '' | 'active' | 'inactive';
  onlySuperAdmins: boolean;
}

export const EMPTY_STAFF_FILTERS: StaffFilters = { venueId: '', role: '', q: '', state: '', onlySuperAdmins: false };

export function staffQuery(f: StaffFilters, cursor: string | null = null, limit: number = SA_PAGE_SIZE): string {
  const active = f.state === 'active' ? true : f.state === 'inactive' ? false : undefined;
  return toQueryString({
    venueId: f.venueId,
    role: f.role,
    q: f.q,
    active,
    superAdmin: f.onlySuperAdmins ? true : undefined,
    cursor,
    limit,
  });
}

// ─── Cuentas de cobro ───────────────────────────────────────────────

export interface PayoutAccountFilters {
  venueId: string;
  method: string;
  q: string;
  onlyMissing: boolean;
  includeInactive: boolean;
}

export const EMPTY_PAYOUT_FILTERS: PayoutAccountFilters = {
  venueId: '',
  method: '',
  q: '',
  onlyMissing: false,
  includeInactive: false,
};

export function payoutAccountsQuery(f: PayoutAccountFilters): string {
  return toQueryString({
    venueId: f.venueId,
    method: f.method,
    q: f.q,
    missing: f.onlyMissing ? true : undefined,
    includeInactive: f.includeInactive ? true : undefined,
  });
}

// ─── Registro ───────────────────────────────────────────────────────

export interface AuditFilters {
  venueId: string;
  actorId: string;
  /** Prefijo de la acción ("superadmin.", "refund."…); '' = todas. */
  action: string;
  /** Días "AAAA-MM-DD" (hora de Madrid), incluidos los dos. '' = sin límite. */
  from: string;
  to: string;
}

export const EMPTY_AUDIT_FILTERS: AuditFilters = { venueId: '', actorId: '', action: '', from: '', to: '' };

/**
 * El API filtra [from, to) en ISO: "desde el día X" = X a las 00:00 de
 * Madrid; "hasta el día Y" = el día siguiente a las 00:00 (Y entero dentro).
 */
export function auditQuery(f: AuditFilters, cursor: string | null = null, limit: number = SA_PAGE_SIZE): string {
  const nextDay = f.to ? addDays(f.to, 1) : null;
  return toQueryString({
    venueId: f.venueId,
    actorId: f.actorId,
    action: f.action,
    from: f.from ? zonedDayStartIso(f.from) : undefined,
    to: nextDay ? zonedDayStartIso(nextDay) : undefined,
    cursor,
    limit,
  });
}

/** Las fechas del filtro tienen sentido (la final no antes que la inicial). */
export function auditRangeProblem(f: Pick<AuditFilters, 'from' | 'to'>): string | null {
  if (f.from && f.to && f.to < f.from) return 'La fecha «hasta» es anterior a «desde».';
  return null;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "AAAA-MM-DD" + n días (calendario, sin horas). null si no es un día. */
export function addDays(day: string, days: number): string | null {
  const m = DAY_RE.exec(day);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days)).toISOString().slice(0, 10);
}

/** Cuánto va la hora de esa zona por delante de UTC en ese instante (ms). */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** Las 00:00 de ese día en esa zona, en ISO (UTC). null si no es un día. */
export function zonedDayStartIso(day: string, timeZone: string = MADRID_TIMEZONE): string | null {
  const m = DAY_RE.exec(day);
  if (!m) return null;
  const midnightUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // Dos pasadas: la segunda corrige el día del cambio de hora.
  const first = midnightUtc - zoneOffsetMs(midnightUtc, timeZone);
  const second = midnightUtc - zoneOffsetMs(first, timeZone);
  return new Date(second).toISOString();
}
