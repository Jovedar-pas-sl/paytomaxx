import { BITCOIN_CASH_MAX_CENTS, BITCOIN_CASH_REFUND_DAYS, confirmationCode } from '@nightpay/contracts';
import { matchInvoiceRef } from '../btcpay/btcpay-resolve';

/**
 * Devolver en efectivo lo pagado con bitcoin: las reglas, sin base de datos.
 * Las decisiones del dueño (17-nov-2026) están en @nightpay/contracts
 * (bitcoin-cash.ts). Cada función dice null si se puede y, si no, por qué.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const PAID: ReadonlySet<string> = new Set(['AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED']);

export function eur(cents: number): string {
  return `${(cents / 100).toFixed(2).replace('.', ',')} €`;
}

/** Hasta 7 días desde el pago (o desde que llegó el bitcoin sin cobro). */
export function withinCashWindow(paidAt: Date | null, now: Date): boolean {
  return paidAt !== null && now.getTime() - paidAt.getTime() <= BITCOIN_CASH_REFUND_DAYS * DAY_MS;
}

/**
 * El dueño lo aprueba cuando PASA de su umbral contando lo ya devuelto del
 * cobro (el dueño no se lo pide a nadie). Umbral null: nunca.
 */
export function needsOwnerApproval(i: { role: string; alreadyCents: number; amountCents: number; thresholdCents: number | null }): boolean {
  if (i.role === 'OWNER' || i.thresholdCents === null) return false;
  return i.alreadyCents + i.amountCents > i.thresholdCents;
}

/**
 * El cliente está delante: el código de su pantalla «Pagado» (3 letras, el
 * del cobro) o el id de su recibo de BTCPay (o un trozo de 6 o más).
 */
export function receiptMatches(raw: string, ids: { paymentId: string; invoiceIds: ReadonlyArray<string | null | undefined> }): boolean {
  const typed = raw.replace(/\s+/g, '').toUpperCase();
  if (typed.length === 3 && typed === confirmationCode(ids.paymentId)) return true;
  return matchInvoiceRef(raw, ids.invoiceIds).ok;
}

/** Lo que se puede devolver de una vez: lo que queda, sin llegar a 1.000 €. */
export function cashAmountProblem(amountCents: number, leftCents: number): string | null {
  if (amountCents <= 0) return 'El importe tiene que ser mayor que 0.';
  if (amountCents > BITCOIN_CASH_MAX_CENTS) return 'Cada devolución en efectivo, por debajo de 1.000 €.';
  if (amountCents > leftCents) return `Como mucho ${eur(leftCents)}: es lo que queda por devolver.`;
  return null;
}

/** Un cobro pagado con bitcoin que se quiere devolver en efectivo. */
export interface CashRefundPayment {
  provider: string | null;
  status: string;
  walletId: string | null;
  authorizedAt: Date | null;
  availableAmountCents: number;
}

/** La factura con la que se pagó (la del cobro). */
export interface PaidInvoice {
  status: string;
  additionalStatus: string | null;
}

/** ¿Se puede devolver en efectivo este cobro? null = sí. */
export function paymentCashProblem(p: CashRefundPayment, invoice: PaidInvoice | null, now: Date): string | null {
  if (p.provider !== 'BTCPAY') return 'Solo se devuelven en efectivo los cobros pagados con bitcoin.';
  // Fase D (saldo cargado con bitcoin): pendiente de lo que decida el dueño.
  if (p.walletId) return 'Una recarga del saldo con bitcoin no se devuelve aquí: habla con el encargado.';
  if (!['AUTHORIZED', 'PARTIALLY_REFUNDED'].includes(p.status)) return 'Este cobro no está pagado: no hay nada que devolver.';
  if (p.availableAmountCents <= 0) return 'Este cobro ya está devuelto del todo.';
  if (!withinCashWindow(p.authorizedAt, now)) return `Han pasado más de ${BITCOIN_CASH_REFUND_DAYS} días desde el pago: ya no se devuelve en efectivo.`;
  // Que el bitcoin llegó lo dice BTCPay (la factura pagada); marcada a mano o resuelta sin ella, no.
  if (!invoice || invoice.status !== 'Settled' || invoice.additionalStatus === 'Marked') {
    return 'BTCPay no confirma que llegara el bitcoin de este cobro (factura sin pagar, marcada a mano o resuelto a mano): no se devuelve en efectivo.';
  }
  return null;
}

/** El bitcoin de una factura que llegó SIN cobro (tarde, dos veces o a medias). */
export interface StrayInvoice {
  invoiceId: string;
  status: string;
  additionalStatus: string | null;
  amountCents: number;
  paidCents: number | null;
  /** Cuándo se cerró la factura (llegó el bitcoin); sin él, la última vez que cambió. */
  closedAt: Date | null;
  updatedAt: Date;
}

/** Lo máximo que se devuelve de esa factura (lo que llegó, en € de la factura), o por qué no. */
export function strayCashMax(
  invoice: StrayInvoice,
  payment: { status: string; providerTxId: string | null },
  now: Date,
): { ok: true; maxCents: number } | { ok: false; problem: string } {
  if (invoice.additionalStatus === 'Marked') return { ok: false, problem: 'La factura se marcó como pagada a mano en BTCPay: no llegó bitcoin que devolver.' };
  // Esta factura pagó el cobro: se devuelve desde el cobro (y lo de más no se devuelve).
  if (PAID.has(payment.status) && payment.providerTxId === invoice.invoiceId) {
    return { ok: false, problem: 'Este bitcoin pagó el cobro: se devuelve con «Devolver en efectivo» del cobro. Lo pagado de más no se devuelve.' };
  }
  const received = invoice.paidCents ?? (invoice.status === 'Settled' ? invoice.amountCents : null);
  if (received === null) return { ok: false, problem: 'No se sabe cuánto bitcoin llegó: míralo en tu BTCPay. Sin ese dato no se devuelve en efectivo.' };
  if (received <= 0) return { ok: false, problem: 'En esta factura no llegó bitcoin.' };
  if (!withinCashWindow(invoice.closedAt ?? invoice.updatedAt, now)) {
    return { ok: false, problem: `Han pasado más de ${BITCOIN_CASH_REFUND_DAYS} días desde que llegó el bitcoin: ya no se devuelve en efectivo.` };
  }
  return { ok: true, maxCents: Math.min(received, BITCOIN_CASH_MAX_CENTS) };
}
