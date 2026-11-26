// El total de la lista de Cobros (lógica pura): dos cifras que NUNCA se suman.
// Lo pagado con el saldo ya entró al recargarlo: sumarlo a lo pagado con
// tarjeta lo contaría dos veces. Se calcula sobre las filas cargadas.

import type { CobroRow } from '@nightpay/contracts';

/** «Importe» de una fila: lo que pagó el cliente (importe + propina + comisión del servicio). */
export function cobroPaidCents(row: Pick<CobroRow, 'amountCents' | 'tipCents' | 'serviceFeeCents'>): number {
  return row.amountCents + row.tipCents + (row.serviceFeeCents ?? 0);
}

export interface CobrosTotals {
  count: number;
  /** Cobros que no son del saldo (también las recargas con tarjeta), en Pagado o Devuelto en parte. */
  cardCents: number;
  /** Cobros del saldo, en Pagado. */
  saldoCents: number;
}

export function cobrosTotals(rows: readonly CobroRow[]): CobrosTotals {
  let cardCents = 0;
  let saldoCents = 0;
  for (const row of rows) {
    if (row.kind === 'SALDO') {
      if (row.status !== 'REVERSED') saldoCents += cobroPaidCents(row);
    } else if (row.status === 'AUTHORIZED' || row.status === 'PARTIALLY_REFUNDED') {
      cardCents += cobroPaidCents(row);
    }
  }
  return { count: rows.length, cardCents, saldoCents };
}

/** «34 cobros»; con más páginas sin cargar, «Los 50 últimos». */
export function totalsLead(count: number, hasMore: boolean): string {
  if (hasMore) return `Los ${count} últimos`;
  return count === 1 ? '1 cobro' : `${count} cobros`;
}

/** Las cifras del total, cada una solo si no es 0. */
export function totalsParts(totals: CobrosTotals): Array<{ cents: number; label: string }> {
  return [
    { cents: totals.cardCents, label: 'con tarjeta o móvil' },
    { cents: totals.saldoCents, label: 'con saldo' },
  ].filter((p) => p.cents !== 0);
}

/** «34 cobros · 725,00 € con tarjeta o móvil · 397,00 € con saldo». */
export function totalsText(rows: readonly CobroRow[], hasMore: boolean, eur: (cents: number) => string): string {
  const totals = cobrosTotals(rows);
  return [totalsLead(totals.count, hasMore), ...totalsParts(totals).map((p) => `${eur(p.cents)} ${p.label}`)].join(' · ');
}
