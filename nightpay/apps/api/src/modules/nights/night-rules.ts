import type { CashOutcome, NightCash } from '@nightpay/contracts';
import { Prisma } from '@nightpay/db';
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

/**
 * Caja de la noche, congelada en el Z: lo que debería haber (fondo + entradas
 * − salidas en efectivo), lo contado y la diferencia. OxioPay no cobra en
 * efectivo: hoy las entradas son 0 y solo cuentan las salidas.
 */
export interface NightCaja {
  openingFloatCents: number | null;
  cashInCents: number;
  walletCashPayoutsCount: number;
  walletCashPayoutsCents: number;
  chicaCashPayoutsCount: number;
  chicaCashPayoutsCents: number;
  cashOutCents: number;
  expectedCents: number;
  /** null = nadie la contó (cierre automático, o sin efectivo). */
  countedCents: number | null;
  /** Contado − esperado (negativo = falta). null si no se contó. */
  diffCents: number | null;
  note: string | null;
  /** Cuándo se congeló. */
  frozenAt: string;
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
  /** Caja (los Z congelados antes del 16-oct-2026 y los de una noche abierta no la traen). */
  caja?: NightCaja;
}

export function buildNightZ(
  window: TimeWindow,
  summary: ExportSummary,
  pendingCount: number,
  now: Date,
  adjustments?: NightAdjustments,
  caja?: NightCaja,
): NightZ {
  return {
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    generatedAt: now.toISOString(),
    summary,
    pendingCount,
    ...(adjustments ? { adjustments } : {}),
    ...(caja ? { caja } : {}),
  };
}

/** El bloque «Caja» del Z con el efectivo de la noche y lo contado (evaluateCash). */
export function buildNightCaja(cash: NightCash, outcome: CashOutcome, note: string | null | undefined, now: Date): NightCaja {
  return {
    openingFloatCents: outcome.floatCents,
    cashInCents: cash.cashInCents,
    walletCashPayoutsCount: cash.walletCashPayoutsCount,
    walletCashPayoutsCents: cash.walletCashPayoutsCents,
    chicaCashPayoutsCount: cash.chicaCashPayoutsCount,
    chicaCashPayoutsCents: cash.chicaCashPayoutsCents,
    cashOutCents: cash.cashOutCents,
    expectedCents: outcome.expectedCents,
    countedCents: outcome.countedCents,
    diffCents: outcome.diffCents,
    note: note?.trim() || null,
    frozenAt: now.toISOString(),
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

/**
 * Cobros de la noche sin resolver (WHERE sobre payments): atascados con el
 * banco, sin confirmar por él o datáfono sin confirmar aún en vigor. Misma
 * fecha que el Z (sin autorizar = la de creación) y la misma hora de corte.
 * Lo usan pendingAtClose del Z y el paso «Cobros sin terminar» del cierre.
 */
export function unresolvedPaymentsWhere(tenantId: string, window: TimeWindow): Prisma.Sql {
  return Prisma.sql`"tenantId" = ${tenantId}::uuid
         AND COALESCE("authorizedAt", "createdAt") >= ${window.from}
         AND COALESCE("authorizedAt", "createdAt") < ${window.to}
         AND (
           status IN ('AUTHORIZING', 'ORPHAN')
           OR ("captureMethod" = 'POS_EXTERNAL'
               AND status IN ('CREATED', 'AWAITING_CAPTURE')
               AND "qrExpiresAt" > ${window.to})
         )`;
}

/**
 * Una noche que nadie cerró se cierra sola en las primeras 08:00 de Madrid
 * tras abrirse. Devuelve esa hora si ya ha llegado; si no, null.
 */
export function autoCloseAt(openedAt: Date, now: Date): Date | null {
  const cutoff = nextNightCutoff(openedAt);
  return cutoff <= now ? cutoff : null;
}
