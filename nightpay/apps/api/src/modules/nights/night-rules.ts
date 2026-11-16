import { expectedCashCents, withServiceFee, type CashOutcome, type MoneyMap, type NightCash } from '@nightpay/contracts';
import { Prisma } from '@nightpay/db';
import { nextNightCutoff } from '../../common/time/madrid';
import { summarize, type ExportSummary } from '../reports/export-csv';
import {
  consumoStaff,
  isChicaPart,
  type AdjustmentRows,
  type ConsumoRow,
  type LiquidacionRow,
  type PagoSaldoRow,
  type RecargaEfectivoRow,
  type SectionLabeler,
} from '../reports/export-rows';
import { cashTopUpsCount } from '../reports/export-summary';
import type { TimeWindow } from '../reports/report-period';
import type { FichasCounts } from '../wallets/fichas-counts';

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
 * − salidas en efectivo), lo contado y la diferencia. Entran las recargas del
 * saldo en efectivo; salen el saldo devuelto en efectivo y los pagos al
 * personal (a las chicas y, aparte, a los camareros).
 */
export interface NightCaja {
  /** El fondo con el que se ha hecho la cuenta. */
  openingFloatCents: number | null;
  /**
   * El fondo que se apuntó al abrir (null = no se apuntó). Si quien cierra lo
   * cambió (con el 2FA del dueño), es distinto del de arriba: el Z guarda los
   * dos. Los Z congelados antes del 21-oct-2026 no lo traen.
   */
  recordedFloatCents?: number | null;
  cashInCents: number;
  /** Recargas en efectivo (los Z congelados antes del 21-oct-2026 no lo traen). */
  walletCashTopUpsCount?: number;
  walletCashTopUpsCents?: number;
  /**
   * «Comisión del servicio» de esas recargas: está en la caja (en cashInCents)
   * y se debe a OxioPay. Los Z congelados antes del 2026-10-26 no lo traen.
   */
  walletCashTopUpFeesCents?: number;
  walletCashPayoutsCount: number;
  walletCashPayoutsCents: number;
  chicaCashPayoutsCount: number;
  chicaCashPayoutsCents: number;
  /** Los Z congelados antes del 28-oct-2026 no lo traen: sus pagos a las chicas son todos los del personal. */
  camareroCashPayoutsCount?: number;
  camareroCashPayoutsCents?: number;
  /** Lo pagado con bitcoin y devuelto en efectivo (solo si lo hubo; los Z de antes del 17-nov-2026 no lo traen). */
  bitcoinCashOutCount?: number;
  bitcoinCashOutCents?: number;
  cashOutCents: number;
  expectedCents: number;
  /** null = nadie la contó (cierre automático, o sin efectivo). */
  countedCents: number | null;
  /**
   * Si se volvió a contar tras «Ver si cuadra» (cierre a ciegas): el primer
   * recuento; countedCents es el último. Sin recuento, no viene.
   */
  firstCountedCents?: number;
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
  /**
   * El corte: cuenta lo apuntado antes de este instante (y el Z siguiente
   * busca ajustes desde aquí, zStart). Al cerrar a mano es el cierre; al
   * cerrarse sola, cuando se generó. Ver night-cutoff.ts.
   */
  generatedAt: string;
  summary: ExportSummary;
  /** Cobros sin resolver en el momento del Z (atascados o datáfono sin confirmar). */
  pendingCount: number;
  /** Ajustes de noches anteriores (los Z congelados antes del 15-oct-2026 no lo traen). */
  adjustments?: NightAdjustments;
  /** Caja (los Z congelados antes del 16-oct-2026 y los de una noche abierta no la traen). */
  caja?: NightCaja;
  /** Fichas NFC de la noche y en el stock (los Z congelados antes del 21-oct-2026 no lo traen). */
  fichas?: FichasCounts;
  /** El mapa del dinero congelado al cerrar (los Z de antes del 24-oct-2026 no lo traen). */
  moneyMap?: MoneyMap;
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
export function buildNightCaja(
  cash: NightCash,
  outcome: CashOutcome,
  note: string | null | undefined,
  now: Date,
  /** El primer recuento, si se volvió a contar (solo cuenta si hay un recuento final). */
  firstCountedCents?: number,
): NightCaja {
  return {
    openingFloatCents: outcome.floatCents,
    recordedFloatCents: cash.openingFloatCents,
    cashInCents: cash.cashInCents,
    walletCashTopUpsCount: cash.walletCashTopUpsCount,
    walletCashTopUpsCents: cash.walletCashTopUpsCents,
    ...withServiceFee({ walletCashTopUpFeesCents: cash.walletCashTopUpFeesCents ?? 0 }),
    walletCashPayoutsCount: cash.walletCashPayoutsCount,
    walletCashPayoutsCents: cash.walletCashPayoutsCents,
    chicaCashPayoutsCount: cash.chicaCashPayoutsCount,
    chicaCashPayoutsCents: cash.chicaCashPayoutsCents,
    camareroCashPayoutsCount: cash.camareroCashPayoutsCount ?? 0,
    camareroCashPayoutsCents: cash.camareroCashPayoutsCents ?? 0,
    ...(cash.bitcoinCashOutCount ? { bitcoinCashOutCount: cash.bitcoinCashOutCount, bitcoinCashOutCents: cash.bitcoinCashOutCents ?? 0 } : {}),
    cashOutCents: cash.cashOutCents,
    expectedCents: outcome.expectedCents,
    countedCents: outcome.countedCents,
    ...(firstCountedCents !== undefined && outcome.countedCents !== null ? { firstCountedCents } : {}),
    diffCents: outcome.diffCents,
    note: note?.trim() || null,
    frozenAt: now.toISOString(),
  };
}

/**
 * El efectivo de la noche a partir de las MISMAS filas que el Z (recargas en
 * efectivo con sus anulaciones, saldo devuelto en efectivo y pagos en
 * efectivo al personal, las chicas y los camareros por separado): la caja y
 * el resumen del Z congelado no pueden salir distintos aunque algo se apunte
 * mientras se cierra.
 */
export function cashFromRows(
  openingFloatCents: number | null,
  rows: {
    recargasEfectivo: ReadonlyArray<RecargaEfectivoRow>;
    pagosSaldo: ReadonlyArray<PagoSaldoRow>;
    liquidaciones: ReadonlyArray<LiquidacionRow>;
    /** Lo pagado con bitcoin y devuelto en efectivo (sale de la caja). */
    bitcoinCashOut?: { count: number; cents: number };
  },
): NightCash {
  const sum = <T>(xs: ReadonlyArray<T>, f: (x: T) => number): number => xs.reduce((a, x) => a + f(x), 0);
  const walletCash = rows.pagosSaldo.filter((p) => p.method === 'CASH');
  const staffCash = rows.liquidaciones.filter((l) => l.externalRail === 'MANUAL_CASH');
  // Sin el puesto (filas de antes): una chica, como en el resumen del Z.
  const camareroCash = staffCash.filter((l) => l.role === 'WAITER');
  const chicaCash = staffCash.filter((l) => l.role !== 'WAITER');
  // Entra lo que pagó el cliente: el saldo + la «Comisión del servicio» (que se debe a OxioPay).
  const walletCashTopUpsCents = sum(rows.recargasEfectivo, (r) => r.amountCents);
  const walletCashTopUpFeesCents = sum(rows.recargasEfectivo, (r) => r.serviceFeeCents ?? 0);
  const cashInCents = walletCashTopUpsCents + walletCashTopUpFeesCents;
  const walletCashPayoutsCents = sum(walletCash, (p) => p.amountCents);
  const chicaCashPayoutsCents = sum(chicaCash, (l) => l.totalCents);
  const camareroCashPayoutsCents = sum(camareroCash, (l) => l.totalCents);
  const btc = rows.bitcoinCashOut ?? { count: 0, cents: 0 };
  const cashOutCents = walletCashPayoutsCents + chicaCashPayoutsCents + camareroCashPayoutsCents + btc.cents;
  return {
    openingFloatCents,
    cashInCents,
    walletCashTopUpsCount: cashTopUpsCount(rows.recargasEfectivo),
    walletCashTopUpsCents,
    ...withServiceFee({ walletCashTopUpFeesCents }),
    walletCashPayoutsCount: walletCash.length,
    walletCashPayoutsCents,
    chicaCashPayoutsCount: chicaCash.length,
    chicaCashPayoutsCents,
    camareroCashPayoutsCount: camareroCash.length,
    camareroCashPayoutsCents,
    ...(btc.count > 0 ? { bitcoinCashOutCount: btc.count, bitcoinCashOutCents: btc.cents } : {}),
    cashOutCents,
    expectedCents: expectedCashCents(openingFloatCents, { cashInCents, cashOutCents }),
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

export function buildAdjustments(args: { before: Date; since: Date; rows: AdjustmentRows; labelOf?: SectionLabeler }): NightAdjustments {
  const { cobros, devoluciones, consumosAnulados } = args.rows;
  const sum = (f: (r: ConsumoRow) => number): number => consumosAnulados.reduce((a, r) => a + f(r), 0);
  return {
    since: args.since.toISOString(),
    before: args.before.toISOString(),
    count: cobros.length + devoluciones.length + consumosAnulados.length,
    summary: summarize(cobros, devoluciones, [], [], [], [], { labelOf: args.labelOf }),
    reversedConsumptionsCount: consumosAnulados.length,
    reversedConsumptionsCents: sum((r) => r.amountCents + r.tipCents),
    // Lo de las chicas de esos consumos (la que cobró y la invitada a una copa).
    reversedConsumptionsChicaCents: sum((r) =>
      consumoStaff(r)
        .filter(isChicaPart)
        .reduce((a, p) => a + p.commissionCents + p.tipCents, 0),
    ),
  };
}

/**
 * Cobros de la noche sin resolver (WHERE sobre payments): atascados con el
 * banco, sin confirmar por él o datáfono sin confirmar aún en vigor (los de
 * las chicas y las recargas de la recepción que el datáfono ya mandó al
 * lector: /start). Misma fecha que el Z (sin autorizar = la de creación) y la
 * misma hora de corte. Lo usan pendingAtClose del Z y el paso «Cobros sin
 * terminar» del cierre.
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
           OR ("captureMethod" = 'WALLET_TOPUP'
               AND status IN ('CREATED', 'AWAITING_CAPTURE')
               AND "qrExpiresAt" > ${window.to}
               AND EXISTS (SELECT 1 FROM payment_events e
                            WHERE e."paymentId" = payments.id AND e."eventType" = 'pos.device_started'))
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
