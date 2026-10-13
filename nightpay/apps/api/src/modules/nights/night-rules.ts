import { nextNightCutoff } from '../../common/time/madrid';
import type { ExportSummary } from '../reports/export-csv';
import type { TimeWindow } from '../reports/report-period';

/**
 * Reglas de la noche del local (Fase 1D). Funciones puras: el servicio lee la
 * base de datos y decide con esto.
 */

/** Informe Z: totales de la noche. Al cerrar se guarda y ya no cambia. */
export interface NightZ {
  from: string;
  to: string;
  generatedAt: string;
  summary: ExportSummary;
  /** Cobros sin resolver en el momento del Z (atascados o datáfono sin confirmar). */
  pendingCount: number;
}

export function buildNightZ(window: TimeWindow, summary: ExportSummary, pendingCount: number, now: Date): NightZ {
  return {
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    generatedAt: now.toISOString(),
    summary,
    pendingCount,
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
