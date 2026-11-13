import { code, date, money, text, time, toCsv, type CsvCell } from '../reports/csv';

/**
 * Las transferencias pendientes de «Lo que sobra», en CSV para hacerlas desde
 * el banco (Excel en español: «;», coma decimal y BOM; reports/csv.ts). Para
 * subirlas de una vez, el fichero SEPA (party-refund-sepa.ts). Después, cada
 * una se marca «Hecha» en el panel.
 */

export interface TransferCsvRow {
  id: string;
  createdAt: Date;
  amountCents: number;
  iban: string;
  email: string | null;
  pulsera: string | null;
  walletCode: string | null;
}

export const TRANSFERS_CSV_HEADER = ['Pedida el', 'Hora', 'Pulsera', 'Código del saldo', 'Importe', 'IBAN', 'Concepto', 'Correo', 'Referencia'] as const;

/** «Devolución OxioParty P-0412»: el concepto de la transferencia (sin datos del asistente). */
export function transferConcept(brand: string, pulsera: string | null, id: string): string {
  return `Devolución ${brand} ${pulsera ?? id.slice(0, 8)}`;
}

export function transfersCsv(rows: ReadonlyArray<TransferCsvRow>, brand: string): string {
  const out: CsvCell[][] = [[...TRANSFERS_CSV_HEADER]];
  for (const r of rows) {
    out.push([
      date(r.createdAt),
      time(r.createdAt),
      code(r.pulsera),
      code(r.walletCode),
      money(r.amountCents),
      code(r.iban),
      text(transferConcept(brand, r.pulsera, r.id)),
      text(r.email),
      code(r.id.slice(0, 8)),
    ]);
  }
  return toCsv(out);
}
