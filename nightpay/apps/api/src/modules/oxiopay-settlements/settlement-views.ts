import { Logger } from '@nestjs/common';
import type { Prisma } from '@nightpay/db';
import {
  conceptsTotal,
  isOpenSettlement,
  settlementPendingCents,
  type OxioPayPayee,
  type SettlementDetail,
  type SettlementListItem,
  type SettlementParty,
} from '@nightpay/contracts';
import { breakdownOf, daysOpen, isOverdue, settlementTotals, StoredBreakdownSchema } from './settlement-rules';

/**
 * De las filas de la base a lo que ven el dueño y la consola. Lo de las
 * listas y la ficha sale de aquí (también el documento y el CSV).
 */

export type SettlementRow = Prisma.OxioPaySettlementGetPayload<Record<string, never>>;
export type SettlementWithPayments = Prisma.OxioPaySettlementGetPayload<{ include: { payments: true } }>;

/** Quién lo ve: el dueño (su local) o la consola del super-admin. */
export type SettlementAudience = 'owner' | 'superadmin';

const logger = new Logger('OxioPaySettlements');

export function payeeOf(row: { name: string; iban: string; holder: string; updatedAt: Date }): OxioPayPayee {
  return { name: row.name, iban: row.iban, holder: row.holder, updatedAt: row.updatedAt.toISOString() };
}

/**
 * El local y su negocio de una liquidación para las listas. Un desglose que no
 * se puede leer no tumba la lista entera (la ficha sí lo dice).
 */
export function partyOf(row: SettlementRow): SettlementParty {
  const parsed = StoredBreakdownSchema.safeParse(row.breakdown);
  if (parsed.success) return parsed.data.party;
  logger.error(`Liquidación ${row.id}: el desglose guardado no se puede leer`);
  return { venueName: row.reference, venueSlug: '', businessName: null, businessTaxId: null };
}

export function listItemOf(row: SettlementRow, now: Date): SettlementListItem {
  const party = partyOf(row);
  return {
    id: row.id,
    reference: row.reference,
    venue: { id: row.tenantId, name: party.venueName, slug: party.venueSlug },
    business: row.businessId && party.businessName ? { id: row.businessId, name: party.businessName } : null,
    periodFrom: row.periodFrom.toISOString(),
    periodTo: row.periodTo.toISOString(),
    isoYear: row.isoYear,
    isoWeek: row.isoWeek,
    status: row.status,
    periodCents: row.periodCents,
    adjustmentsCents: row.adjustmentsCents,
    totalCents: row.totalCents,
    paidCents: row.paidCents,
    pendingCents: settlementPendingCents(row),
    generatedAt: row.generatedAt.toISOString(),
    auto: row.auto,
    overdue: isOverdue(row, now),
    daysOpen: isOpenSettlement(row.status) ? daysOpen(row.generatedAt, now) : 0,
  };
}

/**
 * La ficha. Por concepto, solo lo de la semana (cuadra con «Total de la
 * semana» y con la tabla por noche); los ajustes van en su bloque. El motivo
 * de una anulación y las notas de los pagos los escribe OxioPay para su
 * registro: al dueño no se le enseñan (ni en el documento).
 */
export function detailOf(
  row: SettlementWithPayments,
  payee: OxioPayPayee | null,
  emails: ReadonlyMap<string, string>,
  now: Date,
  audience: SettlementAudience,
): SettlementDetail {
  const b = breakdownOf(row.breakdown);
  const nights = b.nights.map((n) => ({ ...n, totalCents: conceptsTotal(n.concepts) }));
  const internal = audience === 'superadmin';
  return {
    ...listItemOf(row, now),
    party: b.party,
    nights,
    adjustments: b.adjustments,
    byConcept: settlementTotals(nights, []).byConcept,
    moneyMapCents: row.moneyMapCents,
    payments: row.payments.map((p) => ({
      id: p.id,
      amountCents: p.amountCents,
      paidOn: p.paidOn.toISOString().slice(0, 10),
      bankReference: p.bankReference,
      reason: internal ? p.reason : null,
      recordedAt: p.recordedAt.toISOString(),
      recordedByEmail: internal ? (emails.get(p.recordedById) ?? null) : null,
    })),
    voidedAt: row.voidedAt?.toISOString() ?? null,
    voidReason: internal ? row.voidReason : null,
    replacesId: row.replacesId,
    payee,
  };
}
