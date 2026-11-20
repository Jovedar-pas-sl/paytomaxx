// OxioParty · Cierre (lógica pura): la tabla de lo que se paga a cada caseta
// (GET /v1/party/settlement), el estado de su cuenta, los avisos antes de
// descargar el fichero del banco y lo que sobró en las pulseras.

import type { PartySettlement, PartySettlementRow, PartySettlementStatus } from '@nightpay/contracts';
import { countText } from './party-live';
import { organizerText } from './party-stalls';
import { formatEur } from './money';

export const SETTLEMENT_STATUS: Readonly<Record<PartySettlementStatus, { text: string; tone: 'success' | 'danger' | 'neutral' }>> = {
  READY: { text: 'IBAN listo', tone: 'success' },
  NO_IBAN: { text: 'Falta IBAN', tone: 'danger' },
  OWN_BAR: { text: 'No se paga', tone: 'neutral' },
  NOTHING: { text: 'Nada que pagar', tone: 'neutral' },
};

export interface SettlementRowView {
  key: string;
  name: string;
  owner: string | null;
  sold: string;
  percent: string;
  organizer: string;
  pay: string;
  status: { text: string; tone: 'success' | 'danger' | 'neutral' };
}

export function settlementRowView(r: PartySettlementRow): SettlementRowView {
  return {
    key: r.stallId ?? 'none',
    name: r.name,
    owner: r.managerName,
    sold: formatEur(r.soldCents),
    percent: r.stallId === null ? 'Del organizador' : organizerText(r.organizerBps),
    organizer: formatEur(r.organizerCents),
    pay: r.ownBar ? '—' : formatEur(r.toPayCents),
    status: SETTLEMENT_STATUS[r.status],
  };
}

/** Lo que conviene saber antes de descargar el fichero del banco (y si se puede). */
export function sepaReadiness(s: Pick<PartySettlement, 'totals' | 'debtor'>): { can: boolean; notes: string[] } {
  const notes: string[] = [];
  if (!s.debtor.ibanMasked) notes.push('El local no tiene su cuenta (IBAN) para hacer las transferencias: la pone OxioPay. Pídesela.');
  if (s.totals.missingIban > 0) {
    notes.push(
      `${countText(s.totals.missingIban, 'caseta no tiene', 'casetas no tienen')} IBAN: no van en el fichero. Pónselo en Casetas o págales aparte.`,
    );
  }
  if (s.totals.transfers === 0) notes.push('No hay transferencias que hacer: ninguna caseta tiene IBAN y algo que cobrar.');
  return { can: Boolean(s.debtor.ibanMasked) && s.totals.transfers > 0, notes };
}

export function transfersText(n: number): string {
  return countText(n, 'transferencia', 'transferencias');
}

/** Lo que sobró en las pulseras: cargado − vendido, lo devuelto y lo que aún queda (con su barra). */
export function leftoverView(s: Pick<PartySettlement, 'wristbands' | 'totals'>): {
  leftover: string;
  formula: string;
  refunded: string;
  left: string;
  refundedPct: number;
} {
  const leftover = s.wristbands.loadedCents - s.totals.soldCents;
  const base = Math.max(1, s.wristbands.refundedCents + Math.max(0, s.wristbands.leftCents));
  return {
    leftover: formatEur(leftover),
    formula: `Cargado ${formatEur(s.wristbands.loadedCents)} − vendido ${formatEur(s.totals.soldCents)}`,
    refunded: formatEur(s.wristbands.refundedCents),
    left: formatEur(s.wristbands.leftCents),
    refundedPct: Math.round((Math.max(0, s.wristbands.refundedCents) / base) * 100),
  };
}

/** Las noches elegidas: las dos o ninguna (la fiesta entera); la última no antes de la primera. */
export function rangeProblem(from: string, to: string): string | null {
  if (!from && !to) return null;
  if (!from || !to) return 'Pon la primera y la última noche (o ninguna: la fiesta entera).';
  return to < from ? 'La última noche es anterior a la primera.' : null;
}
