import {
  ORGANIZER_OWN_BAR_BPS,
  maskIban,
  organizerShareCents,
  settlementStatusOf,
  type PartySettlement,
  type PartySettlementRow,
} from '@nightpay/contracts';
import type { StallTotals } from './party-live-rules';

/**
 * La liquidación por caseta (lógica pura): lo vendido de cada una (las
 * mismas cuentas que el directo), la parte del organizador
 * (round(vendido · bps / 10000)) y lo que se le paga (vendido − esa parte).
 * La «barra propia» (10000) y lo vendido sin caseta son todo del organizador
 * y no se pagan. En el fichero del banco solo van las que tienen IBAN y algo
 * que pagar. La parte del organizador es la de la caseta AHORA (no se fija en
 * cada cobro): cambiarla cambia la liquidación.
 */

export interface SettlementStall {
  id: string;
  name: string;
  managerName: string;
  organizerBps: number;
  iban: string | null;
  active: boolean;
  sortOrder: number;
}

export interface SettlementInput {
  window: { from: Date | null; to: Date };
  fromNight: string | null;
  toNight: string | null;
  now: Date;
  eventName: string;
  stalls: readonly SettlementStall[];
  totals: ReadonlyMap<string | null, StallTotals>;
  debtor: { name: string; iban: string | null };
  wristbands: { loadedCents: number; refundedCents: number; leftCents: number };
}

export function settlementRowOf(stall: SettlementStall, soldCents: number, count: number): PartySettlementRow {
  const ownBar = stall.organizerBps === ORGANIZER_OWN_BAR_BPS;
  const organizerCents = organizerShareCents(soldCents, stall.organizerBps);
  const toPayCents = ownBar ? 0 : soldCents - organizerCents;
  const hasIban = Boolean(stall.iban);
  return {
    stallId: stall.id,
    name: stall.name,
    managerName: stall.managerName,
    soldCents,
    count,
    organizerBps: stall.organizerBps,
    ownBar,
    organizerCents,
    toPayCents,
    hasIban,
    ibanMasked: maskIban(stall.iban),
    status: settlementStatusOf({ ownBar, toPayCents, hasIban, stallId: stall.id }),
  };
}

/** Las filas: las casetas activas y las que vendieron, en su orden; «Sin caseta» al final si vendió algo. */
export function settlementRowsOf(stalls: readonly SettlementStall[], totals: ReadonlyMap<string | null, StallTotals>): PartySettlementRow[] {
  const rows = [...stalls]
    .filter((s) => s.active || (totals.get(s.id)?.count ?? 0) > 0 || (totals.get(s.id)?.cents ?? 0) !== 0)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'es'))
    .map((s) => settlementRowOf(s, totals.get(s.id)?.cents ?? 0, totals.get(s.id)?.count ?? 0));
  const none = totals.get(null);
  if (!none || (none.count === 0 && none.cents === 0)) return rows;
  return [
    ...rows,
    {
      stallId: null,
      name: 'Sin caseta',
      managerName: null,
      soldCents: none.cents,
      count: none.count,
      organizerBps: ORGANIZER_OWN_BAR_BPS,
      ownBar: true,
      organizerCents: none.cents,
      toPayCents: 0,
      hasIban: false,
      ibanMasked: null,
      status: 'OWN_BAR',
    },
  ];
}

const sum = (rows: readonly PartySettlementRow[], f: (r: PartySettlementRow) => number): number => rows.reduce((a, r) => a + f(r), 0);

export function buildPartySettlement(i: SettlementInput): PartySettlement {
  const rows = settlementRowsOf(i.stalls, i.totals);
  const ready = rows.filter((r) => r.status === 'READY');
  return {
    from: i.window.from?.toISOString() ?? null,
    to: i.window.to.toISOString(),
    fromNight: i.fromNight,
    toNight: i.toNight,
    generatedAt: i.now.toISOString(),
    eventName: i.eventName,
    rows,
    totals: {
      soldCents: sum(rows, (r) => r.soldCents),
      organizerCents: sum(rows, (r) => r.organizerCents),
      toPayCents: sum(rows, (r) => r.toPayCents),
      transfers: ready.length,
      transfersCents: sum(ready, (r) => r.toPayCents),
      missingIban: rows.filter((r) => r.status === 'NO_IBAN').length,
    },
    debtor: { name: i.debtor.name, ibanMasked: maskIban(i.debtor.iban) },
    wristbands: i.wristbands,
  };
}
