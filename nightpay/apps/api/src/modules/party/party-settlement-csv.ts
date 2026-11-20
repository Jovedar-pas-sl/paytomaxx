import type { PartySettlement, PartySettlementRow, PartySettlementStatus } from '@nightpay/contracts';
import { money, text, toCsv, type CsvCell } from '../reports/csv';

/**
 * La liquidación por caseta en CSV (Excel en español: «;», coma decimal y
 * BOM, como los demás). El IBAN va tapado: el entero solo en el fichero del
 * banco. Funciones puras.
 */

const STATUS_LABEL: Readonly<Record<PartySettlementStatus, string>> = {
  READY: 'IBAN listo',
  NO_IBAN: 'Falta IBAN',
  OWN_BAR: 'No se paga',
  NOTHING: 'Nada que pagar',
};

/** 2500 → "25,00"; 10000 → "100,00". */
export function percent(bps: number): string {
  return money(bps);
}

const HEADER: readonly string[] = [
  'Caseta',
  'Responsable',
  'Cobros',
  'Vendido',
  '% del organizador',
  'Para el organizador',
  'A pagar a la caseta',
  'IBAN',
  'Estado',
];

function rowOf(r: PartySettlementRow): CsvCell[] {
  return [
    text(r.name),
    text(r.managerName),
    r.count,
    money(r.soldCents),
    r.stallId === null ? '' : r.ownBar ? 'Barra propia' : percent(r.organizerBps),
    money(r.organizerCents),
    money(r.toPayCents),
    r.ibanMasked ?? '',
    STATUS_LABEL[r.status],
  ];
}

export function partySettlementCsv(s: PartySettlement): string {
  const t = s.totals;
  return toCsv([
    HEADER,
    ...s.rows.map(rowOf),
    ['Total', '', s.rows.reduce((a, r) => a + r.count, 0), money(t.soldCents), '', money(t.organizerCents), money(t.toPayCents), '', `${t.transfers} transferencias`],
  ]);
}

/** «oxioparty-liquidacion-2026-06-23_2026-06-24.csv» (o «-fiesta» sin fechas). */
export function partySettlementFileName(s: Pick<PartySettlement, 'fromNight' | 'toNight'>, ext: 'csv' | 'xml'): string {
  const range = s.fromNight && s.toNight ? (s.fromNight === s.toNight ? s.fromNight : `${s.fromNight}_${s.toNight}`) : 'fiesta';
  return `oxioparty-${ext === 'xml' ? 'transferencias' : 'liquidacion'}-${range}.${ext}`;
}
