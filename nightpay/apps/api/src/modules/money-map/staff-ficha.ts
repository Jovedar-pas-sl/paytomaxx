import {
  formatChargeRef,
  invitationRulesOf,
  isSectionCode,
  isZeroShare,
  type InvitationRules,
  type SectionAmount,
  type StaffFichaRow,
  type StaffRate,
} from '@nightpay/contracts';
import { chargeSections, type LineAmount } from '../reports/charge-sections';
import { formatWalletCode } from '../wallets/wallet-rules';
import { paymentMethodOf, paymentVia, saldoVia, type PersonLike, personOf } from './cobros-rows';

/**
 * Ficha de la chica (y del camarero) en el panel, maqueta 9.2 (lógica pura):
 * de sus ganancias de la noche (staff-ficha.service) a las filas, lo vendido,
 * lo suyo y lo que le toca de cada cosa.
 */

/** Una ganancia de la noche con su cobro (con tarjeta o del saldo). */
export interface EarningFeedRow {
  id: string;
  at: Date;
  commissionCents: number;
  tipCents: number;
  reversedCents: number;
  /** Base de la comisión: en una invitación, lo de sus copas. */
  paymentAmountCents: number;
  /** De una invitación («Copa con invitación»). */
  paymentLineId: string | null;
  paymentId: string | null;
  ref: number | null;
  chargeAmountCents: number;
  chargeTipCents: number;
  category: string;
  serviceName: string | null;
  captureMethod: string | null;
  posOperationNumber: string | null;
  approvedPayMethod: string | null;
  authorizedAt: Date | null;
  paymentStatus: string | null;
  authMethod: string | null;
  reversedAt: Date | null;
  walletCode: string | null;
  lines: LineAmount[] | null;
  /** La sección de las copas de la invitación. */
  invitationCategory: string | null;
  chargedBy: PersonLike | null;
  /**
   * Lo que ya debe de este cobro: devoluciones o anulaciones que llegaron
   * con su parte ya pagada (earning_reversals.afterPayout). No están en
   * reversedCents (eso es lo que se le pagó).
   */
  debtCents: number;
}

/**
 * Una devolución de la ventana de un cobro con tarjeta de otra noche
 * (earning_reversals): el mapa del dinero y el Z la restan de lo del personal
 * la noche de la devolución, así que la ficha también.
 */
export interface ReversalFeedRow {
  /** El descuento (earning_reversals). */
  id: string;
  /** La devolución (la fecha del banco o la de apuntarla, como el mapa). */
  at: Date;
  /** El cobro (la noche en que se cobró). */
  chargedAt: Date;
  reversedDeltaCents: number;
  refundAmountCents: number;
  /** De una invitación («Copa con invitación»). */
  paymentLineId: string | null;
  ref: number | null;
  chargeAmountCents: number;
  category: string;
  captureMethod: string | null;
  posOperationNumber: string | null;
  approvedPayMethod: string | null;
  authorizedAt: Date | null;
  lines: LineAmount[] | null;
  invitationCategory: string | null;
  chargedBy: PersonLike | null;
}

function sectionsOf(row: { chargeAmountCents: number; category: string; lines: LineAmount[] | null }): SectionAmount[] {
  return [...chargeSections({ amountCents: row.chargeAmountCents, category: row.category, lines: row.lines })].map(
    ([category, amountCents]) => ({ category, amountCents }),
  );
}

/** «1 h», «Invitación», «Propina» o el servicio; si no, «Cobro». */
function titleOf(row: EarningFeedRow): string {
  if (row.paymentLineId) return 'Invitación';
  if (row.commissionCents === 0 && row.tipCents > 0) return 'Propina';
  return row.serviceName?.trim() || 'Cobro';
}

/** Cómo pagó un cobro con tarjeta (o datáfono). */
function cardMethodOf(row: Pick<EarningFeedRow, 'captureMethod' | 'posOperationNumber' | 'authorizedAt' | 'approvedPayMethod'>) {
  return paymentMethodOf({
    captureMethod: row.captureMethod,
    posOperationNumber: row.posOperationNumber,
    authorizedAt: row.authorizedAt,
    attempts: row.approvedPayMethod ? [{ status: 'APPROVED', payMethod: row.approvedPayMethod }] : [],
  });
}

/** La sección para el color: la de las copas de la invitación o la principal del cobro. */
function sectionFor(invitation: boolean, invitationCategory: string | null, sections: readonly SectionAmount[], category: string): string {
  const section = invitation ? (invitationCategory ?? 'VENUE_BAR') : (sections[0]?.category ?? category);
  return isSectionCode(section) ? section : 'EXTRA';
}

export function staffFichaRow(row: EarningFeedRow, personId: string): StaffFichaRow {
  const invitation = row.paymentLineId !== null;
  const kind = row.paymentId ? 'PAYMENT' : 'SALDO';
  const method = kind === 'SALDO' ? 'SALDO' : cardMethodOf(row);
  const sections = sectionsOf(row);
  const undone = kind === 'SALDO' ? row.reversedAt !== null : row.paymentStatus === 'REFUNDED';
  return {
    id: row.id,
    at: row.at.toISOString(),
    ref: formatChargeRef(row.ref),
    kind,
    section: sectionFor(invitation, row.invitationCategory, sections, row.category),
    sections,
    title: titleOf(row),
    method,
    via: kind === 'SALDO' ? saldoVia(row.authMethod) : paymentVia(method, false),
    walletCode: row.walletCode ? formatWalletCode(row.walletCode) : null,
    chargedBy: row.chargedBy && row.chargedBy.id !== personId ? personOf(row.chargedBy) : null,
    invitation,
    amountCents: invitation ? row.paymentAmountCents : row.chargeAmountCents + row.chargeTipCents,
    shareCents: row.commissionCents + row.tipCents - row.reversedCents - row.debtCents,
    undone,
  };
}

/** Una devolución de esta noche de un cobro de otra noche: «C-4790 · Devolución», lo devuelto y lo que se le resta. */
export function staffReversalRow(row: ReversalFeedRow, personId: string): StaffFichaRow {
  const invitation = row.paymentLineId !== null;
  const method = cardMethodOf(row);
  const sections = sectionsOf(row);
  return {
    id: row.id,
    at: row.at.toISOString(),
    ref: formatChargeRef(row.ref),
    kind: 'PAYMENT',
    section: sectionFor(invitation, row.invitationCategory, sections, row.category),
    sections,
    title: 'Devolución',
    method,
    via: paymentVia(method, false),
    walletCode: null,
    chargedBy: row.chargedBy && row.chargedBy.id !== personId ? personOf(row.chargedBy) : null,
    invitation,
    amountCents: row.refundAmountCents,
    shareCents: -row.reversedDeltaCents,
    undone: false,
    refundOf: { chargedAt: row.chargedAt.toISOString() },
  };
}

/**
 * Lo vendido y lo suyo (sin lo devuelto o anulado del todo: ya no cuenta).
 * Las devoluciones de cobros de otras noches no son venta: solo restan de lo
 * suyo, como en el mapa del dinero.
 */
export function staffStats(rows: readonly StaffFichaRow[], paidCents: number): { soldCents: number; shareCents: number; paidCents: number; count: number } {
  const live = rows.filter((r) => !r.undone && !r.refundOf);
  return {
    soldCents: live.reduce((a, r) => a + r.amountCents, 0),
    shareCents: rows.reduce((a, r) => a + r.shareCents, 0),
    paidCents,
    count: live.length,
  };
}

/**
 * Lo que le toca de cada cosa: a la chica, su % de cada sección (el suyo en
 * Servicios, o el del local), su parte de las copas con invitación y las
 * propinas; al camarero, su parte de las invitaciones solo si el dueño le da
 * algo (de fábrica, nada).
 */
export function staffRates(input: {
  role: 'OPERATOR' | 'WAITER';
  commissionBps: number | null;
  defaults: Partial<Record<string, number>> | null;
  invitationRules: unknown;
}): StaffRate[] {
  const rules: InvitationRules = invitationRulesOf(input.invitationRules);
  const hasShare = (s: InvitationRules['chica']) => !isZeroShare(s);
  if (input.role === 'WAITER') return hasShare(rules.camarero) ? [{ kind: 'invitation', share: rules.camarero }] : [];
  const defaults = input.defaults ?? {};
  const sections: StaffRate[] = Object.entries(defaults).flatMap(([code, bps]): StaffRate[] => {
    if (!isSectionCode(code)) return [];
    const own = code === 'CHICA_SERVICE' && input.commissionBps !== null ? input.commissionBps : (bps ?? 0);
    return own > 0 ? [{ kind: 'section', code, bps: own }] : [];
  });
  if (!sections.some((r) => r.kind === 'section' && r.code === 'CHICA_SERVICE') && (input.commissionBps ?? 0) > 0) {
    sections.unshift({ kind: 'section', code: 'CHICA_SERVICE', bps: input.commissionBps ?? 0 });
  }
  return [
    ...sections,
    ...(hasShare(rules.chica) ? [{ kind: 'invitation' as const, share: rules.chica }] : []),
    { kind: 'tips', bps: 10_000 },
  ];
}
