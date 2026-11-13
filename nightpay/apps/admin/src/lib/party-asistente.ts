// OxioParty · Pulseras y Devoluciones del panel: lo que no es pintar (textos,
// qué botón sale en cada fila, los números del lote). Sin React: se prueba solo.

import {
  PARTY_REFUND_METHOD_LABEL,
  PARTY_REFUND_STATUS_LABEL,
  PULSERA_BATCH_MAX,
  WALLET_CARD_STATUS_LABEL,
  formatMoney,
  parsePulseraNumber,
  pulseraLabel,
  type PartyRefundMethod,
  type PartyRefundRow,
  type PartyRefundStatus,
  type PartyRefundTotals,
  type PulseraCounts,
  type PulseraRow,
  type WalletCardStatus,
} from '@nightpay/contracts';

const eur = (cents: number): string => formatMoney(cents);

/**
 * El error de cargar una sección, en palabras: 403 (no es el dueño ni el
 * encargado) y 404 (el panel no es de una fiesta: EDITION=club); el resto, su mensaje.
 */
export function sectionError(err: unknown, what: 'pulseras' | 'devoluciones'): string {
  const status = (err as { status?: number } | null)?.status;
  if (status === 403) return `Las ${what} las ven el dueño y el encargado.`;
  if (status === 404) return 'Esto es de OxioParty: este panel no es el de una fiesta.';
  return (err as Error)?.message || 'No se ha podido cargar.';
}

// ─── Pulseras ───────────────────────────────────────────────────────────

/** Los estados en el orden de la vida de una pulsera. */
export const PULSERA_STATUSES: readonly WalletCardStatus[] = ['STOCK', 'ISSUED', 'RETURNED', 'LOST', 'BLOCKED'];

/** El recuento, en plural (la fila, en singular: WALLET_CARD_STATUS_LABEL). */
export const PULSERA_COUNT_LABEL: Readonly<Record<WalletCardStatus, string>> = {
  STOCK: 'En stock',
  ISSUED: 'Entregadas',
  RETURNED: 'Devueltas',
  LOST: 'Perdidas',
  BLOCKED: 'Bloqueadas',
};

export function pulseraStatusLabel(status: WalletCardStatus): string {
  return WALLET_CARD_STATUS_LABEL[status];
}

/** Los filtros del buscador («Todas» y cada estado con su cuenta). */
export function pulseraFilters(counts: PulseraCounts | null): Array<{ value: WalletCardStatus | ''; label: string }> {
  const n = (k: WalletCardStatus | 'total') => (counts ? ` (${counts[k]})` : '');
  return [{ value: '', label: `Todas${n('total')}` }, ...PULSERA_STATUSES.map((s) => ({ value: s, label: `${PULSERA_COUNT_LABEL[s]}${n(s)}` }))];
}

/** Cuántas preparar: un entero de 1 a 500 (lo que se teclea). */
export function parseBatchCount(raw: string): number | null {
  if (!/^\s*\d{1,4}\s*$/.test(raw)) return null;
  const n = Number(raw.trim());
  return n >= 1 && n <= PULSERA_BATCH_MAX ? n : null;
}

/** Un número de pulsera tecleado («P-0412», «412») o null. */
export function pulseraNumberInput(raw: string): number | null {
  return parsePulseraNumber(raw);
}

/** El rango de la hoja: de un número a otro, como mucho 500 (lo que pide el API). */
export function sheetRangeProblem(from: number | null, to: number | null): string | null {
  if (from === null || to === null) return 'Escribe de qué número a qué número (P-0001 a P-0100).';
  if (to < from) return 'El primer número tiene que ser el menor.';
  if (to - from + 1 > PULSERA_BATCH_MAX) return `Como mucho ${PULSERA_BATCH_MAX} pulseras por hoja.`;
  return null;
}

export function sheetFileName(from: number, to: number): string {
  return `pulseras-${pulseraLabel(from)}-${pulseraLabel(to)}.html`;
}

/** Qué se puede hacer con una pulsera desde el panel. */
export function pulseraActions(row: PulseraRow): { block: boolean; replace: boolean } {
  const withWallet = row.walletCode !== null;
  return {
    // Bloquear (ya no paga): una entregada.
    block: row.status === 'ISSUED',
    // Perdida: pasar su saldo a otra (también si ya se bloqueó o se marcó perdida).
    replace: withWallet && (row.status === 'ISSUED' || row.status === 'BLOCKED' || row.status === 'LOST'),
  };
}

export function blockConfirmText(row: PulseraRow): string {
  return `¿Bloquear la pulsera ${row.label}? Deja de pagar al momento (también sin PIN). El saldo no se pierde: luego se pasa a otra pulsera.`;
}

export function replaceDoneText(from: string, to: string, balanceCents: number): string {
  return `${from} bloqueada. Su saldo (${eur(balanceCents)}) ya está en ${to}.`;
}

// ─── Devoluciones ───────────────────────────────────────────────────────

export const REFUND_STATUS_FILTERS: ReadonlyArray<{ value: PartyRefundStatus | ''; label: string }> = [
  { value: '', label: 'Todas' },
  { value: 'PENDING', label: 'Pendientes' },
  { value: 'DONE', label: 'Hechas' },
  { value: 'CANCELED', label: 'Anuladas' },
];

export const REFUND_METHOD_FILTERS: ReadonlyArray<{ value: PartyRefundMethod | ''; label: string }> = [
  { value: '', label: 'Todas las formas' },
  { value: 'CARD', label: 'A la tarjeta' },
  { value: 'TRANSFER', label: 'Por transferencia' },
  { value: 'DONATE', label: 'Donado' },
];

export function refundMethodLabel(m: PartyRefundMethod): string {
  return PARTY_REFUND_METHOD_LABEL[m];
}

export function refundStatusLabel(s: PartyRefundStatus): string {
  return PARTY_REFUND_STATUS_LABEL[s];
}

/** Qué botones lleva una fila: «Hecha» (tarjeta o transferencia pendiente) y «Anular» (pendiente). */
export function refundActions(row: PartyRefundRow): { done: boolean; cancel: boolean } {
  const pending = row.status === 'PENDING';
  return { done: pending && row.method !== 'DONATE', cancel: pending };
}

export function refundDoneConfirm(row: PartyRefundRow): string {
  const who = row.pulsera ?? row.walletCode ?? 'esta pulsera';
  return row.method === 'CARD'
    ? `¿Ya devolviste ${eur(row.amountCents)} a la tarjeta de ${who} en el portal del banco? Al marcarla «Hecha», ese dinero sale de su saldo.`
    : `¿Ya enviaste la transferencia de ${eur(row.amountCents)} a ${row.ibanHint ?? 'su IBAN'} (${who})? Al marcarla «Hecha», ese dinero sale de su saldo.`;
}

export function refundCancelConfirm(row: PartyRefundRow): string {
  return `¿Anular la devolución de ${eur(row.amountCents)} (${row.pulsera ?? row.walletCode ?? 'sin pulsera'})? No sale nada y su saldo vuelve a poder gastarse.`;
}

/** Las cifras de arriba: lo pendiente a la tarjeta, por transferencia, lo hecho y lo donado. */
export function refundTiles(t: PartyRefundTotals): Array<{ key: string; label: string; value: string; hint: string; strong?: boolean }> {
  const pendingCount = t.pending.CARD.count + t.pending.TRANSFER.count;
  const doneCents = t.done.CARD.cents + t.done.TRANSFER.cents;
  const doneCount = t.done.CARD.count + t.done.TRANSFER.count;
  return [
    {
      key: 'card',
      label: 'Pendiente a la tarjeta',
      value: eur(t.pending.CARD.cents),
      hint: `${t.pending.CARD.count} ${t.pending.CARD.count === 1 ? 'devolución' : 'devoluciones'} · se hacen a mano en el banco`,
      strong: pendingCount > 0,
    },
    {
      key: 'transfer',
      label: 'Pendiente por transferencia',
      value: eur(t.pending.TRANSFER.cents),
      hint: `${t.pending.TRANSFER.count} ${t.pending.TRANSFER.count === 1 ? 'transferencia' : 'transferencias'} · en el CSV`,
    },
    { key: 'done', label: 'Ya devuelto', value: eur(doneCents), hint: `${doneCount} hechas` },
    {
      key: 'donated',
      label: 'Donado a la comisión',
      value: eur(t.donatedCents),
      hint: `${t.done.DONATE.count} ${t.done.DONATE.count === 1 ? 'asistente' : 'asistentes'}`,
    },
  ];
}

export function transfersFileName(day: string, kind: 'csv' | 'sepa' = 'csv'): string {
  return `transferencias-pendientes-${day}.${kind === 'sepa' ? 'xml' : 'csv'}`;
}
