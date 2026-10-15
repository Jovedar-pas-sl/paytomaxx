import { nextNightCutoff } from '../../common/time/madrid';
import { summarize, type ExportSummary } from '../reports/export-csv';
import type { AdjustmentRows, ConsumoRow } from '../reports/export-rows';
import type { TimeWindow } from '../reports/report-period';

/**
 * Reglas de la noche del local (Fase 1D). Funciones puras: el servicio lee la
 * base de datos y decide con esto.
 */

/**
 * Ajustes de noches anteriores: lo apuntado después de generar el Z anterior
 * con fecha de una noche ya cerrada (un cobro que el banco confirmó tarde, una
 * devolución apuntada con la fecha del banco de otro día, un consumo anulado
 * después). Esos Z no cambian: los ajustes van en el Z siguiente.
 */
export interface NightAdjustments {
  /** Apuntado desde que se generó el Z anterior (o desde que se abrió la primera noche)… */
  since: string;
  /** …con fecha anterior al inicio de esta noche. */
  before: string;
  /** Cuántos apuntes: cobros, devoluciones y consumos anulados. */
  count: number;
  /** Cobros pagados tarde y devoluciones con fecha de días ya cerrados. */
  summary: ExportSummary;
  /** Consumos del saldo de noches anteriores anulados después: la chica pierde su parte. */
  reversedConsumptionsCount: number;
  reversedConsumptionsCents: number;
  reversedConsumptionsChicaCents: number;
}

/** Informe Z: totales de la noche. Al cerrar se guarda y ya no cambia. */
export interface NightZ {
  from: string;
  to: string;
  generatedAt: string;
  summary: ExportSummary;
  /** Cobros sin resolver en el momento del Z (atascados o datáfono sin confirmar). */
  pendingCount: number;
  /** Ajustes de noches anteriores (los Z congelados antes del 15-oct-2026 no lo traen). */
  adjustments?: NightAdjustments;
}

export function buildNightZ(
  window: TimeWindow,
  summary: ExportSummary,
  pendingCount: number,
  now: Date,
  adjustments?: NightAdjustments,
): NightZ {
  return {
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    generatedAt: now.toISOString(),
    summary,
    pendingCount,
    ...(adjustments ? { adjustments } : {}),
  };
}

/** La noche anterior ya cerrada, con su Z congelado. */
export interface PreviousClose {
  closedAt: Date | null;
  zReport: unknown;
}

/**
 * Desde dónde cuenta el Z de una noche: desde el cierre de la anterior (como
 * el Z de una caja) o, la primera noche, desde que se abrió. Y desde cuándo
 * se buscan ajustes: lo apuntado después de generar el Z anterior (lo de
 * antes ya lo contó él, aunque se cerrara sola a las 08:00 y se generase después).
 */
export function zStart(previous: PreviousClose | null, openedAt: Date): { from: Date; since: Date } {
  const from = previous?.closedAt ?? openedAt;
  const generated = generatedAtOf(previous?.zReport);
  return { from, since: generated && generated.getTime() > from.getTime() ? generated : from };
}

function generatedAtOf(z: unknown): Date | null {
  if (!z || typeof z !== 'object') return null;
  const raw = (z as { generatedAt?: unknown }).generatedAt;
  if (typeof raw !== 'string') return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

export function buildAdjustments(args: { before: Date; since: Date; rows: AdjustmentRows }): NightAdjustments {
  const { cobros, devoluciones, consumosAnulados } = args.rows;
  const sum = (f: (r: ConsumoRow) => number): number => consumosAnulados.reduce((a, r) => a + f(r), 0);
  return {
    since: args.since.toISOString(),
    before: args.before.toISOString(),
    count: cobros.length + devoluciones.length + consumosAnulados.length,
    summary: summarize(cobros, devoluciones, []),
    reversedConsumptionsCount: consumosAnulados.length,
    reversedConsumptionsCents: sum((r) => r.amountCents + r.tipCents),
    reversedConsumptionsChicaCents: sum((r) => (r.commissionCents ?? 0) + (r.earningTipCents ?? 0)),
  };
}

export type CloseDecision =
  | { ok: true }
  | { ok: false; reason: 'pending' | 'force-owner-only' | 'note-required' };

/**
 * No se cierra con cobros sin resolver: se resuelven antes en Pagos. Solo el
 * dueño puede cerrar igualmente, y dejando una nota de por qué.
 */
export function decideClose(args: {
  pendingCount: number;
  force: boolean;
  role: string;
  note: string | undefined;
}): CloseDecision {
  if (args.force) {
    if (args.role !== 'OWNER') return { ok: false, reason: 'force-owner-only' };
    if ((args.note?.trim().length ?? 0) < 3) return { ok: false, reason: 'note-required' };
    return { ok: true };
  }
  return args.pendingCount > 0 ? { ok: false, reason: 'pending' } : { ok: true };
}

/**
 * Una noche que nadie cerró se cierra sola en las primeras 08:00 de Madrid
 * tras abrirse. Devuelve esa hora si ya ha llegado; si no, null.
 */
export function autoCloseAt(openedAt: Date, now: Date): Date | null {
  const cutoff = nextNightCutoff(openedAt);
  return cutoff <= now ? cutoff : null;
}
