// El ticket impreso (papel de 58 mm, 48 mm de impresión): lo que se le da al
// cliente en la mano. Como un ticket normal: el local, el número y la hora, lo
// que se compró, los importes, el total y cómo se pagó. Funciones puras, solo
// con datos que la app ya tiene. Nunca lleva el nombre de quien cobra ni el
// reparto: el papel se lo lleva el cliente.

import { formatMoney, type CobroDetail } from '@nightpay/contracts';
import type { OutcomeHow } from '../components/PaymentOutcome';

/** Una línea de lo comprado: «2× Gin tonic … 24,00 €». */
export interface TicketLine {
  label: string;
  qty: number;
  /** El precio de una (para «12,00 € c/u» si son varias). */
  unitCents?: number | null;
  amountCents: number;
}

export interface TicketRow {
  label: string;
  value: string;
}

export interface Ticket {
  /** El nombre del local, arriba y grande. */
  venue?: string | null;
  /** «Ticket», «Carga de saldo», «Escanea para pagar», «Prueba de impresión». */
  title: string;
  /** El número del cobro («C-0063»). */
  number?: string | null;
  /** La fecha y la hora (de Madrid). */
  at: Date;
  lines: readonly TicketLine[];
  /** Entre las líneas y el total: «Subtotal», «Propina», «Comisión del servicio». */
  amounts: readonly TicketRow[];
  /** El total (null: sin total, como la prueba). */
  totalCents: number | null;
  currency?: string;
  /** Debajo del total: cómo se pagó y sus códigos. */
  payment: readonly TicketRow[];
  /** Un QR para escanear con el móvil (el enlace del cobro). */
  qrUrl?: string | null;
  /** Bajo el QR: «Vale hasta las 01:27». */
  qrNote?: string | null;
  /** Las líneas del pie (centradas). */
  footer: readonly string[];
}

/** El pie de un pago: es un comprobante, no una factura (la factura, si la pide, la hace el local). */
export const RECEIPT_FOOTER: readonly string[] = ['¡Gracias por tu visita!', 'Comprobante de pago, no factura.'];

/** El pie de una carga de saldo. */
export const TOP_UP_FOOTER: readonly string[] = ['Guarda tu ficha y este ticket.', 'Comprobante de carga, no factura.'];

const MADRID_DATE_TIME = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const MADRID_TIME = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** «16/11/2026 16:20», hora de Madrid (un datáfono en UTC la daría mal). */
export function ticketDateTime(at: Date): string {
  const parts = MADRID_DATE_TIME.formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${part('day')}/${part('month')}/${part('year')} ${part('hour')}:${part('minute')}`;
}

/** «01:27», hora de Madrid. */
export function ticketTime(at: Date): string {
  return MADRID_TIME.format(at);
}

/** Importe del ticket: siempre con céntimos («24,00 €»), como un ticket de caja. */
export function ticketMoney(cents: number, currency = 'EUR'): string {
  return formatMoney(cents, { currency });
}

/** Subtotal, propina y comisión, solo si hay propina o comisión (si no, el total basta). */
function amountRows(amountCents: number, tipCents: number, feeCents: number, currency?: string): TicketRow[] {
  if (tipCents <= 0 && feeCents <= 0) return [];
  const rows: TicketRow[] = [{ label: 'Subtotal', value: ticketMoney(amountCents, currency) }];
  if (tipCents > 0) rows.push({ label: 'Propina', value: ticketMoney(tipCents, currency) });
  if (feeCents > 0) rows.push({ label: 'Comisión del servicio', value: ticketMoney(feeCents, currency) });
  return rows;
}

/** Etiquetas de «cómo se pagó» que no van al papel: quién cobró y la hora (ya va arriba). */
const STAFF_ONLY_ROWS = new Set(['Cobró', 'Hora']);
/** Las del PAGADO dichas como en un ticket. */
const ROW_WORDS: Readonly<Record<string, string>> = { 'Le quedan': 'Saldo restante', 'Código del cobro': 'Código' };

/** «Con tarjeta» → «Tarjeta»; «Con ficha nº 1013» → «Ficha nº 1013». */
function methodWord(title: string): string {
  const bare = title.replace(/^Con (su |la |el )?/i, '').replace(/^En /i, '');
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}

/** Cómo se pagó, desde la tarjeta del PAGADO: la forma de pago y sus filas (sin quién cobró). */
export function howRows(how: OutcomeHow): TicketRow[] {
  const rows: TicketRow[] = [{ label: 'Pago', value: methodWord(how.title) }];
  for (const r of how.rows) {
    if (STAFF_ONLY_ROWS.has(r.label)) continue;
    rows.push({ label: ROW_WORDS[r.label] ?? r.label, value: r.value });
  }
  return rows;
}

export interface PaidTicketInput {
  venue?: string | null;
  number?: string | null;
  /** Lo comprado (la cuenta); sin ella, una línea con el total. */
  lines?: readonly TicketLine[];
  /** Lo de la cuenta, sin propina ni comisión (por defecto, el total). */
  amountCents?: number;
  tipCents?: number;
  serviceFeeCents?: number;
  /** Lo que pagó en total. */
  totalCents: number;
  currency?: string;
  /** La tarjeta de «cómo se pagó» del PAGADO. */
  how?: OutcomeHow | null;
  at: Date;
}

/** El ticket de un cobro pagado con lo que sabe la pantalla del PAGADO. */
export function paidTicket(i: PaidTicketInput): Ticket {
  const tip = Math.max(0, i.tipCents ?? 0);
  const fee = Math.max(0, i.serviceFeeCents ?? 0);
  const amount = i.amountCents ?? i.totalCents - tip - fee;
  return {
    title: 'Ticket',
    venue: i.venue ?? null,
    number: i.number ?? null,
    at: i.at,
    lines: i.lines && i.lines.length > 0 ? i.lines : [{ label: 'Consumición', qty: 1, amountCents: amount }],
    amounts: amountRows(amount, tip, fee, i.currency),
    totalCents: i.totalCents,
    currency: i.currency,
    payment: i.how ? howRows(i.how) : [],
    footer: RECEIPT_FOOTER,
  };
}

/** Lo que sabe la pantalla y el detalle no dice al personal. */
export interface ReceiptExtra {
  /** El saldo que le queda tras pagar (lo da el cobro al pagarse; null: no se sabe). */
  balanceAfterCents?: number | null;
}

/** Cómo se pagó, desde el detalle del cobro (Cobros). */
function detailPaymentRows(d: CobroDetail, extra: ReceiptExtra): TicketRow[] {
  const rows: TicketRow[] = [];
  const m = d.method;
  if (m.cardLast4) rows.push({ label: 'Tarjeta', value: `${m.cardBrand ?? ''} •••• ${m.cardLast4}`.trim() });
  else if (m.fichaNumber) rows.push({ label: 'Pago', value: `Ficha nº ${m.fichaNumber}` });
  else if (m.label && m.label !== '—') rows.push({ label: 'Pago', value: m.label });
  if (d.bank?.authCode) rows.push({ label: 'Autorización', value: d.bank.authCode });
  if (d.confirmationCode) rows.push({ label: 'Código', value: d.confirmationCode });
  const balanceAfter = d.balance?.afterCents ?? extra.balanceAfterCents ?? null;
  if (balanceAfter !== null) rows.push({ label: d.isTopUp ? 'Saldo ahora' : 'Saldo restante', value: ticketMoney(balanceAfter) });
  for (const u of d.undo) {
    if (u.amountCents === null) continue;
    const label = u.kind === 'REFUND' ? 'Devuelto a la tarjeta' : u.kind === 'VOID' ? 'Devuelto al saldo' : 'Anulado';
    rows.push({ label, value: ticketMoney(u.amountCents) });
  }
  return rows;
}

/** El ticket de un cobro desde su detalle (pestaña Cobros, o el PAGADO cuando ya ha llegado). */
export function receiptFromDetail(d: CobroDetail, extra: ReceiptExtra = {}): Ticket {
  const lines: TicketLine[] = d.isTopUp
    ? [{ label: 'Carga de saldo', qty: 1, amountCents: d.amountCents }]
    : d.lines.map((l) => ({ label: l.label, qty: l.qty, unitCents: l.unitCents, amountCents: l.amountCents }));
  return {
    title: d.isTopUp ? 'Carga de saldo' : 'Ticket',
    venue: d.venueName,
    number: d.ref,
    at: new Date(d.paidAt ?? d.createdAt),
    lines: lines.length > 0 ? lines : [{ label: d.service ?? 'Consumición', qty: 1, amountCents: d.amountCents }],
    amounts: amountRows(d.amountCents, d.tipCents, d.serviceFeeCents),
    totalCents: d.totalCents,
    payment: detailPaymentRows(d, extra),
    footer: d.isTopUp ? TOP_UP_FOOTER : RECEIPT_FOOTER,
  };
}

export interface PayQrTicketInput {
  venue?: string | null;
  amountCents: number;
  currency?: string;
  /** El enlace del cobro (el mismo del QR de la pantalla). */
  qrUrl: string;
  /** Hasta cuándo vale el QR (null: no se sabe). */
  expiresAt: Date | null;
  at: Date;
}

/** El QR del cobro en papel: el cliente lo escanea y paga en su móvil. */
export function payQrTicket(i: PayQrTicketInput): Ticket {
  return {
    title: 'Escanea para pagar',
    venue: i.venue ?? null,
    at: i.at,
    lines: [],
    amounts: [],
    totalCents: i.amountCents,
    currency: i.currency,
    payment: [],
    qrUrl: i.qrUrl,
    qrNote: i.expiresAt ? `Vale hasta las ${ticketTime(i.expiresAt)}` : null,
    footer: ['Escanéalo con la cámara de tu móvil.', 'Tarjeta, Apple Pay, Google Pay o tu saldo.'],
  };
}

export interface TopUpTicketInput {
  venue?: string | null;
  number?: string | null;
  /** Lo que se cargó en el saldo. */
  amountCents: number;
  /** La comisión del servicio que pagó encima (0: sin ella). */
  feeCents?: number;
  method: 'cash' | 'card';
  /** El número impreso de la ficha (null: sin ficha). */
  ficha?: string | null;
  /** El código del saldo (K7Q-4M2), si se enseña en pantalla. */
  code?: string | null;
  /** Lo que tiene ahora (null: no se sabe). */
  balanceCents?: number | null;
  at: Date;
}

/** El ticket de una carga de saldo en recepción. */
export function topUpTicket(i: TopUpTicketInput): Ticket {
  const fee = Math.max(0, i.feeCents ?? 0);
  const payment: TicketRow[] = [{ label: 'Pago', value: i.method === 'cash' ? 'Efectivo' : 'Tarjeta' }];
  if (i.ficha) payment.push({ label: 'Ficha', value: `nº ${i.ficha}` });
  if (i.code) payment.push({ label: 'Código del saldo', value: i.code });
  if (i.balanceCents !== null && i.balanceCents !== undefined) payment.push({ label: 'Saldo ahora', value: ticketMoney(i.balanceCents) });
  return {
    title: 'Carga de saldo',
    venue: i.venue ?? null,
    number: i.number ?? null,
    at: i.at,
    lines: [{ label: 'Carga de saldo', qty: 1, amountCents: i.amountCents }],
    amounts: amountRows(i.amountCents, 0, fee),
    totalCents: i.amountCents + fee,
    payment,
    footer: TOP_UP_FOOTER,
  };
}

/**
 * La prueba de «Este aparato»: un ticket de ejemplo que no es un cobro. El QR
 * lleva la dirección de la propia app (`qrUrl`), para comprobar que se lee.
 */
export function testTicket(at: Date, qrUrl: string, venue?: string | null): Ticket {
  return {
    title: 'Prueba de impresión',
    venue: venue ?? null,
    at,
    lines: [
      { label: 'Gin tonic', qty: 2, unitCents: 1200, amountCents: 2400 },
      { label: 'Nachos', qty: 1, unitCents: 900, amountCents: 900 },
    ],
    amounts: [],
    totalCents: 3300,
    payment: [{ label: 'Pago', value: 'Esto no es un cobro' }],
    qrUrl,
    qrNote: 'El QR debe leerse con el móvil',
    footer: ['Si lo lees bien, la impresora va.'],
  };
}
