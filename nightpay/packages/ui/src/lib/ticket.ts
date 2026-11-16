// El ticket impreso (papel de 58 mm): lo que se le da al cliente en la mano.
// Funciones puras: qué lleva cada ticket, solo con datos que la pantalla ya
// tiene. Va al cliente, así que nunca lleva el nombre de quien cobra ni la
// sección del cobro: solo el local, el importe, cómo se pagó y sus códigos.

import { formatMoney } from '@nightpay/contracts';
import type { OutcomeHow } from '../components/PaymentOutcome';

export interface TicketRow {
  label: string;
  value: string;
}

export interface Ticket {
  /** «Comprobante de pago», «Carga de saldo», «Escanea para pagar». */
  title: string;
  /** El nombre del local, arriba (si se sabe). */
  venue?: string | null;
  amountCents: number;
  currency?: string;
  /** Bajo el importe: «Con tarjeta», «Con ficha nº 1013», «En efectivo». */
  how?: string | null;
  /** Frases bajo el importe: «33 € + 3 € de propina». */
  notes?: readonly string[];
  /** Las filas de abajo: «Código del cobro  K7Q4», «Le quedan  26 €». */
  rows: readonly TicketRow[];
  /** Un QR para escanear con el móvil (el enlace del cobro). */
  qrUrl?: string | null;
  /** Bajo el QR: «Vale hasta las 01:27». */
  qrNote?: string | null;
  /** Cuándo: la fecha y la hora de Madrid, arriba. */
  at: Date;
  /** La referencia del cobro o del saldo («C-0023»), arriba. */
  reference?: string | null;
  /** Las líneas del pie. */
  footer: readonly string[];
}

/** El pie de un pago: es un comprobante, no una factura (la factura, si se pide, la hace el local). */
export const RECEIPT_FOOTER: readonly string[] = ['Comprobante de pago.', 'No es una factura.'];

/** El pie de una carga de saldo. */
export const TOP_UP_FOOTER: readonly string[] = ['Comprobante de la carga.', 'No es una factura.', 'Guárdalo con tu ficha.'];

/**
 * Hora de Madrid (la del local), no la del aparato: un datáfono en UTC la
 * daría 1-2 h mal.
 */
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

/** «16/11/2026 16:20», hora de Madrid. */
export function ticketDateTime(at: Date): string {
  const parts = MADRID_DATE_TIME.formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${part('day')}/${part('month')}/${part('year')} ${part('hour')}:${part('minute')}`;
}

/** «01:27», hora de Madrid. */
export function ticketTime(at: Date): string {
  return MADRID_TIME.format(at);
}

/** Etiquetas de «cómo se pagó» que no van al papel: quién cobró (el cliente no lo necesita) y la hora (ya va arriba). */
const STAFF_ONLY_ROWS = new Set(['Cobró', 'Hora']);

/** Las filas de «cómo se pagó» que sí van al ticket del cliente. */
export function howRows(how: OutcomeHow): TicketRow[] {
  return how.rows.filter((r) => !STAFF_ONLY_ROWS.has(r.label)).map(({ label, value }) => ({ label, value }));
}

export interface PaidTicketInput {
  venue?: string | null;
  /** Lo que pagó en total (con la comisión y la propina, si las hubo). */
  amountCents: number;
  currency?: string;
  /** La tarjeta de «cómo se pagó» del PAGADO: su título y sus filas. */
  how?: OutcomeHow | null;
  /** «33 € + 3 € de propina», si lo hay. */
  breakdown?: string | null;
  reference?: string | null;
  at: Date;
}

/** El comprobante de un cobro pagado (con tarjeta, Apple/Google Pay, el saldo o la ficha). */
export function paidTicket(i: PaidTicketInput): Ticket {
  return {
    title: 'Comprobante de pago',
    venue: i.venue ?? null,
    amountCents: i.amountCents,
    currency: i.currency,
    how: i.how?.title ?? null,
    notes: i.breakdown ? [i.breakdown] : [],
    rows: i.how ? howRows(i.how) : [],
    reference: i.reference ?? null,
    at: i.at,
    footer: RECEIPT_FOOTER,
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
  reference?: string | null;
  at: Date;
}

/** El QR del cobro en papel: el cliente lo escanea con su móvil y paga allí. */
export function payQrTicket(i: PayQrTicketInput): Ticket {
  return {
    title: 'Escanea para pagar',
    venue: i.venue ?? null,
    amountCents: i.amountCents,
    currency: i.currency,
    how: 'Con la cámara de tu móvil',
    rows: [],
    qrUrl: i.qrUrl,
    qrNote: i.expiresAt ? `Vale hasta las ${ticketTime(i.expiresAt)}` : null,
    reference: i.reference ?? null,
    at: i.at,
    footer: ['Pagas en tu móvil: tarjeta, Apple Pay,', 'Google Pay o tu saldo.'],
  };
}

export interface TopUpTicketInput {
  venue?: string | null;
  /** Lo que se cargó en el saldo. */
  amountCents: number;
  /** La comisión del servicio que pagó encima (0: sin ella). */
  feeCents?: number;
  /** «bitcoin»: el QR de la carga, que el cliente pagó con bitcoin desde su móvil. */
  method: 'cash' | 'card' | 'bitcoin';
  /** El número impreso de la ficha (null: sin ficha). */
  ficha?: string | null;
  /** El código del saldo (K7Q-4M2), si se enseña en pantalla. */
  code?: string | null;
  /** Lo que tiene ahora (null: no se sabe). */
  balanceCents?: number | null;
  reference?: string | null;
  at: Date;
}

/** Cómo se pagó la carga, tal como sale en el papel. */
const TOP_UP_HOW: Readonly<Record<TopUpTicketInput['method'], string>> = {
  cash: 'En efectivo',
  card: 'Con tarjeta',
  bitcoin: 'Con bitcoin',
};

/** El comprobante de una carga de saldo en recepción. */
export function topUpTicket(i: TopUpTicketInput): Ticket {
  const eur = (cents: number) => formatMoney(cents, { compact: true });
  const fee = Math.max(0, i.feeCents ?? 0);
  const rows: TicketRow[] = [];
  if (fee > 0) rows.push({ label: 'Comisión del servicio', value: eur(fee) }, { label: 'Pagado', value: eur(i.amountCents + fee) });
  if (i.ficha) rows.push({ label: 'Ficha', value: `nº ${i.ficha}` });
  if (i.code) rows.push({ label: 'Código del saldo', value: i.code });
  if (i.balanceCents !== null && i.balanceCents !== undefined) rows.push({ label: 'Saldo ahora', value: eur(i.balanceCents) });
  return {
    title: 'Carga de saldo',
    venue: i.venue ?? null,
    amountCents: i.amountCents,
    how: TOP_UP_HOW[i.method],
    rows,
    reference: i.reference ?? null,
    at: i.at,
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
    amountCents: 0,
    how: 'Esto no es un cobro',
    rows: [{ label: 'Si lo lees bien', value: 'la impresora va' }],
    qrUrl,
    qrNote: 'El QR debe leerse con el móvil',
    at,
    footer: ['OxioPay'],
  };
}
