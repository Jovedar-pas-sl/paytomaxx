import { z } from 'zod';
import {
  SETTLEMENT_CONCEPTS,
  SETTLEMENT_OVERDUE_DAYS,
  SettlementAdjustmentSchema,
  SettlementConceptAmountsSchema,
  SettlementPartySchema,
  addConcepts,
  conceptsTotal,
  emptyConceptAmounts,
  isOpenSettlement,
  type SettlementAdjustment,
  type SettlementConceptAmounts,
  type SettlementNight,
  type SettlementStatus,
} from '@nightpay/contracts';
import type { SettlementNightWindow, SettlementWeek } from './settlement-week';

/**
 * Reglas puras de la «Liquidación OxioPay». La cifra de cada noche y concepto
 * es la del mapa del dinero (MoneyMapService.oxioPayOwed); lo ya liquidado se
 * lleva en un «libro» por noche y concepto (las liquidaciones no anuladas: sus
 * noches y sus ajustes). Lo de una semana es lo de sus noches menos lo ya
 * liquidado de ellas (la primera vez, nada: es lo del mapa); lo que cambió
 * después en una semana ya liquidada (algo apuntado tarde con su fecha) es la
 * diferencia, y va a la siguiente como «ajustes de semanas anteriores». Así
 * cada céntimo se liquida una vez, aunque llegue tarde o se anule y regenere.
 */

/** El desglose congelado (oxiopay_settlements.breakdown). */
export const StoredBreakdownSchema = z.object({
  version: z.literal(1),
  party: SettlementPartySchema,
  /** El % de plataforma del local con el que se calculó (para recalcular esa semana igual). */
  platformBps: z.number().int(),
  nights: z.array(
    z.object({ day: z.string(), from: z.string(), to: z.string(), concepts: SettlementConceptAmountsSchema }),
  ),
  adjustments: z.array(SettlementAdjustmentSchema),
});
export type StoredBreakdown = z.infer<typeof StoredBreakdownSchema>;

/** Lo guardado, comprobado (un desglose que no lo es es un fallo: se dice). */
export function breakdownOf(raw: unknown): StoredBreakdown {
  return StoredBreakdownSchema.parse(raw);
}

/** Lo ya liquidado por noche (AAAA-MM-DD) y concepto: noches y ajustes de las liquidaciones no anuladas. */
export function ledgerOf(breakdowns: readonly StoredBreakdown[]): Map<string, SettlementConceptAmounts> {
  const ledger = new Map<string, SettlementConceptAmounts>();
  const add = (day: string, amounts: SettlementConceptAmounts) => ledger.set(day, addConcepts(ledger.get(day) ?? emptyConceptAmounts(), amounts));
  for (const b of breakdowns) {
    for (const night of b.nights) add(night.day, night.concepts);
    for (const a of b.adjustments) add(a.day, { ...emptyConceptAmounts(), [a.concept]: a.amountCents });
  }
  return ledger;
}

function minus(a: SettlementConceptAmounts, b: SettlementConceptAmounts | undefined): SettlementConceptAmounts {
  if (!b) return a;
  return Object.fromEntries(SETTLEMENT_CONCEPTS.map((k) => [k, a[k] - b[k]])) as SettlementConceptAmounts;
}

export function sameConcepts(a: SettlementConceptAmounts, b: SettlementConceptAmounts): boolean {
  return SETTLEMENT_CONCEPTS.every((k) => a[k] === b[k]);
}

/** Las 7 noches de la semana: lo del mapa de cada una menos lo ya liquidado de ella. */
export function periodNights(
  computed: ReadonlyArray<SettlementNightWindow & { concepts: SettlementConceptAmounts }>,
  ledger: ReadonlyMap<string, SettlementConceptAmounts>,
): SettlementNight[] {
  return computed.map((n) => {
    const concepts = minus(n.concepts, ledger.get(n.day));
    return { day: n.day, from: n.from.toISOString(), to: n.to.toISOString(), concepts, totalCents: conceptsTotal(concepts) };
  });
}

/** Lo ya liquidado de un grupo de noches (una semana), sumado. */
export function ledgerTotal(days: readonly string[], ledger: ReadonlyMap<string, SettlementConceptAmounts>): SettlementConceptAmounts {
  return days.reduce((acc, d) => addConcepts(acc, ledger.get(d) ?? emptyConceptAmounts()), emptyConceptAmounts());
}

export interface RecomputedWeek {
  week: SettlementWeek;
  /** Su liquidación (null si no la tuvo). */
  reference: string | null;
  /** Lo del mapa de cada noche ahora. */
  nights: ReadonlyArray<{ day: string; concepts: SettlementConceptAmounts }>;
}

/** Lo que cambió en semanas ya liquidadas: una línea por noche y concepto con diferencia (en el orden de los conceptos). */
export function adjustmentLines(
  weeks: readonly RecomputedWeek[],
  ledger: ReadonlyMap<string, SettlementConceptAmounts>,
): SettlementAdjustment[] {
  const lines: SettlementAdjustment[] = [];
  for (const w of weeks) {
    for (const night of w.nights) {
      const diff = minus(night.concepts, ledger.get(night.day));
      for (const concept of SETTLEMENT_CONCEPTS) {
        if (diff[concept] === 0) continue;
        lines.push({
          weekFrom: w.week.monday,
          isoYear: w.week.isoYear,
          isoWeek: w.week.isoWeek,
          reference: w.reference,
          day: night.day,
          concept,
          amountCents: diff[concept],
        });
      }
    }
  }
  return lines;
}

export interface SettlementTotals {
  periodCents: number;
  adjustmentsCents: number;
  totalCents: number;
  byConcept: SettlementConceptAmounts;
}

export function settlementTotals(
  nights: ReadonlyArray<{ concepts: SettlementConceptAmounts }>,
  adjustments: readonly SettlementAdjustment[],
): SettlementTotals {
  const period = nights.reduce((acc, n) => addConcepts(acc, n.concepts), emptyConceptAmounts());
  const adjusted = adjustments.reduce(
    (acc, a) => addConcepts(acc, { ...emptyConceptAmounts(), [a.concept]: a.amountCents }),
    emptyConceptAmounts(),
  );
  const periodCents = conceptsTotal(period);
  const adjustmentsCents = conceptsTotal(adjusted);
  return { periodCents, adjustmentsCents, totalCents: periodCents + adjustmentsCents, byConcept: addConcepts(period, adjusted) };
}

const DAY_MS = 86_400_000;

/** Días enteros desde que se emitió. */
export function daysOpen(generatedAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - generatedAt.getTime()) / DAY_MS));
}

/** Abierta y emitida hace MÁS de 7 días: aviso por Telegram y en el panel del dueño. */
export function isOverdue(s: { status: SettlementStatus; generatedAt: Date }, now: Date): boolean {
  return isOpenSettlement(s.status) && now.getTime() - s.generatedAt.getTime() > SETTLEMENT_OVERDUE_DAYS * DAY_MS;
}
