// Vistas, fichas y columnas de la lista de Cobros (lógica pura). Las vistas son
// atajos de dos filtros (estado y forma de pago); las fichas dicen qué hay
// filtrado y lo quitan; las columnas de más se guardan en el navegador.

import { CHARGE_METHOD_LABELS, LEGACY_SECTION_META, type ChargeMethod, type VenueSection } from '@nightpay/contracts';
import { formatDateTime } from './dates';
import type { CobrosFilters } from './endpoints/money-map';
import { sectionLabelOf } from './money-map';

// ─── Vistas ─────────────────────────────────────────────────────────────

export type CobrosViewKey = 'todos' | 'problema' | 'devueltos' | 'saldo';

export interface CobrosView {
  key: CobrosViewKey;
  label: string;
  status: readonly string[];
  method: ChargeMethod | null;
}

export const COBROS_VIEWS: readonly CobrosView[] = [
  { key: 'todos', label: 'Todos', status: [], method: null },
  { key: 'problema', label: 'Con problema', status: ['ORPHAN', 'AUTHORIZING', 'FAILED'], method: null },
  { key: 'devueltos', label: 'Devueltos', status: ['REFUNDED', 'PARTIALLY_REFUNDED'], method: null },
  // Ficha, código o Face ID: el API no separa la ficha.
  { key: 'saldo', label: 'Con saldo', status: [], method: 'SALDO' },
];

/** La vista marcada: la que tiene exactamente ese estado y esa forma de pago (los demás filtros no cuentan). */
export function activeView(filter: CobrosFilters): CobrosViewKey | null {
  const status = [...(filter.status ?? [])].sort().join(',');
  const method = filter.method ?? null;
  return COBROS_VIEWS.find((v) => v.method === method && [...v.status].sort().join(',') === status)?.key ?? null;
}

/** Elegir una vista cambia solo el estado y la forma de pago. */
export function applyView(filter: CobrosFilters, key: CobrosViewKey): CobrosFilters {
  const view = COBROS_VIEWS.find((v) => v.key === key)!;
  const next = withoutFilters(filter, ['status', 'method']);
  if (view.status.length > 0) next.status = [...view.status];
  if (view.method) next.method = view.method;
  return next;
}

// ─── Filtros y fichas ───────────────────────────────────────────────────

/** Los estados que se pueden filtrar, con la misma palabra que la tabla (cobro-status). */
export const STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'CREATED', label: 'Sin pagar' },
  { value: 'AUTHORIZING', label: 'Esperando pago' },
  { value: 'AUTHORIZED', label: 'Pagado' },
  { value: 'FAILED', label: 'Rechazado' },
  { value: 'EXPIRED', label: 'Caducado' },
  { value: 'REFUNDED', label: 'Devuelto' },
  { value: 'PARTIALLY_REFUNDED', label: 'Devuelto en parte' },
  { value: 'ORPHAN', label: 'Sin confirmar' },
];

/** El filtro sin esas claves (y sin las que hayan quedado vacías). */
export function withoutFilters(filter: CobrosFilters, keys: ReadonlyArray<keyof CobrosFilters>): CobrosFilters {
  const next: CobrosFilters = { ...filter };
  for (const k of keys) delete next[k];
  for (const k of Object.keys(next) as Array<keyof CobrosFilters>) {
    const v = next[k];
    if (v === '' || v === undefined || (Array.isArray(v) && v.length === 0)) delete next[k];
  }
  return next;
}

export interface ChipContext {
  tz: string;
  nights: ReadonlyArray<{ id: string; openedAt: string }>;
  operators: ReadonlyArray<{ id: string; name: string }>;
  sections: readonly VenueSection[];
}

export interface FilterChip {
  key: string;
  /** «Estado: Devuelto» (la ✕ la pinta el botón). */
  label: string;
  /** Lo que quita su ✕. */
  clears: Array<keyof CobrosFilters>;
}

/** «sáb 14»: la noche, por el día en que se abrió (hora del local). */
export function nightDay(openedAt: string, tz: string): string {
  const parts = new Intl.DateTimeFormat('es-ES', { timeZone: tz, weekday: 'short', day: 'numeric' }).formatToParts(new Date(openedAt));
  const of = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${of('weekday').replace('.', '')} ${of('day')}`;
}

/** Una ficha por filtro puesto, en el orden de la barra. */
export function filterChips(filter: CobrosFilters, ctx: ChipContext): FilterChip[] {
  const chips: FilterChip[] = [];
  const status = filter.status ?? [];
  if (status.length > 0) {
    const first = STATUS_OPTIONS.find((s) => s.value === status[0])?.label ?? status[0]!;
    chips.push({ key: 'status', label: `Estado: ${first}${status.length > 1 ? ` y ${status.length - 1} más` : ''}`, clears: ['status'] });
  }
  if (filter.nightId) {
    const night = ctx.nights.find((n) => n.id === filter.nightId);
    chips.push({ key: 'night', label: `Noche: ${night ? nightDay(night.openedAt, ctx.tz) : 'elegida'}`, clears: ['nightId'] });
  }
  if (filter.operatorId) {
    chips.push({ key: 'operator', label: `Compañera: ${ctx.operators.find((o) => o.id === filter.operatorId)?.name ?? 'elegida'}`, clears: ['operatorId'] });
  }
  if (filter.category) {
    const label = filter.category === 'EXTRA' ? LEGACY_SECTION_META.label : sectionLabelOf(ctx.sections, filter.category);
    chips.push({ key: 'category', label: `Sección: ${label}`, clears: ['category'] });
  }
  if (filter.method) chips.push({ key: 'method', label: `Forma de pago: ${CHARGE_METHOD_LABELS[filter.method]}`, clears: ['method'] });
  if (filter.walletCode) chips.push({ key: 'walletCode', label: `Código del saldo: ${filter.walletCode}`, clears: ['walletCode'] });
  if (filter.search) chips.push({ key: 'search', label: `Buscar: ${filter.search}`, clears: ['search'] });
  if (filter.from || filter.to) {
    const from = filter.from ? formatDateTime(filter.from, ctx.tz, 'short') : 'el principio';
    const to = filter.to ? formatDateTime(filter.to, ctx.tz, 'short') : 'ahora';
    chips.push({ key: 'fechas', label: `Fechas del mapa: ${from} → ${to}`, clears: ['from', 'to'] });
  }
  return chips;
}

/** El número de «Filtros (N)» en el móvil: lo elegido dentro de la hoja (el buscador está fuera, a la vista). */
export function activeFilterCount(filter: CobrosFilters): number {
  return [filter.status?.length, filter.nightId, filter.operatorId, filter.category, filter.method, filter.walletCode, filter.from || filter.to].filter(Boolean).length;
}

// ─── La hora de una fila ────────────────────────────────────────────────

const DAY_AFTER_MS = 18 * 60 * 60 * 1000;

/** «02:14»; pasadas 18 horas, «14 nov, 02:14» (hora del local). */
export function hourText(iso: string, tz: string, nowMs: number): string {
  return formatDateTime(iso, tz, nowMs - Date.parse(iso) > DAY_AFTER_MS ? 'short' : 'time');
}

// ─── Columnas de más ────────────────────────────────────────────────────

export type CobrosColumn = 'ref' | 'codigo' | 'banco';

export const COBROS_COLUMNS: ReadonlyArray<{ key: CobrosColumn; label: string }> = [
  { key: 'ref', label: 'Referencia' },
  { key: 'codigo', label: 'Código' },
  { key: 'banco', label: 'Ref. del banco' },
];

/** Donde se guardan en el navegador. */
export const COLUMNS_STORAGE_KEY = 'np-cobros-cols';

/** Lo guardado, saneado: solo columnas que existen, sin repetir y en su orden. */
export function parseColumns(raw: string | null): CobrosColumn[] {
  let stored: unknown;
  try {
    stored = raw ? JSON.parse(raw) : null;
  } catch {
    stored = null;
  }
  return Array.isArray(stored) ? COBROS_COLUMNS.map((c) => c.key).filter((k) => stored.includes(k)) : [];
}
