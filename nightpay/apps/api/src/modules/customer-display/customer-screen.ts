import { createHash } from 'node:crypto';
import type { CustomerScreenEnd, CustomerScreenView } from '@nightpay/contracts';
import { PAID_STATES } from '../payments/pay-redirect';
import type { PaymentMachineState } from '../payments/payment.machine';
import { cardQrUrl } from '../payments/pay-qr-url';

/**
 * Lo que enseña la «Pantalla del cliente», calculado aquí con lo de la base
 * (nunca con lo que diga el móvil del camarero): «Pagado» solo si el cobro
 * está pagado de verdad. Sin datos personales: ni el saldo del cliente ni
 * quién cobra; solo el importe, el QR y el estado.
 */

/** El cobro con tarjeta (su QR). */
export interface ScreenPayment {
  id: string;
  status: string;
  amountCents: number;
  serviceFeeCents: number;
  currency: string;
  qrToken: string;
  qrExpiresAt: Date;
  captureMethod: string | null;
  /** Una recarga de saldo (recepción). */
  walletId: string | null;
}

/** El cobro del saldo (la ficha, su PIN o el QR del saldo suelto). */
export interface ScreenCharge {
  id: string;
  /** PENDING | ACCEPTED | REJECTED | EXPIRED | CANCELED */
  status: string;
  amountCents: number;
  expiresAt: Date;
  payToken: string | null;
}

export interface ScreenInput {
  venueName: string;
  /** El local cobra con ficha (saldo y NFC encendidos). */
  fichas: boolean;
  pairedUntil: Date;
  payment: ScreenPayment | null;
  charge: ScreenCharge | null;
  /** El camarero ya salió de ese cobro (Nuevo cobro, otra pantalla). */
  cleared: boolean;
  now: Date;
  urls: { api: string; client: string; operator: string };
}

/** El cobro aún se puede pagar (o se está pagando: banco, sin respuesta). */
const CARD_OPEN: ReadonlySet<string> = new Set(['CREATED', 'AWAITING_CAPTURE', 'AUTHORIZING', 'ORPHAN']);
/** Ya en el banco: el QR ya se escaneó. */
const CARD_PAYING: ReadonlySet<string> = new Set(['AUTHORIZING', 'ORPHAN']);
/** Esperando a que se escanee: caduca con su QR. */
const CARD_WAITING_QR: ReadonlySet<string> = new Set(['CREATED', 'AWAITING_CAPTURE']);

/** Identifica el cobro sin enseñar sus ids (opaco). */
export function displayKey(paymentId: string | null, chargeId: string | null): string {
  return createHash('sha256')
    .update(`${paymentId ?? ''}|${chargeId ?? ''}`)
    .digest('hex')
    .slice(0, 16);
}

function cardOpen(p: ScreenPayment, now: Date): boolean {
  if (!CARD_OPEN.has(p.status)) return false;
  // Sin escanear y con el QR caducado (la tarea aún no lo ha marcado): ya no.
  return !CARD_WAITING_QR.has(p.status) || p.qrExpiresAt.getTime() > now.getTime();
}

function chargeOpen(c: ScreenCharge, now: Date): boolean {
  return c.status === 'PENDING' && c.expiresAt.getTime() > now.getTime();
}

function cardPaid(p: ScreenPayment | null): boolean {
  return p !== null && PAID_STATES.has(p.status as PaymentMachineState);
}

/** Por qué no se pagó: el de tarjeta manda (es el del QR); si no hay, el del saldo. */
function endReason(input: ScreenInput): CustomerScreenEnd {
  const { payment: p, charge: c, now } = input;
  if (p) {
    if (p.status === 'FAILED') return 'failed';
    if (p.status === 'EXPIRED' || (CARD_WAITING_QR.has(p.status) && p.qrExpiresAt.getTime() <= now.getTime())) {
      return 'expired';
    }
    return 'canceled';
  }
  if (c?.status === 'REJECTED') return 'failed';
  if (c && (c.status === 'EXPIRED' || (c.status === 'PENDING' && c.expiresAt.getTime() <= now.getTime()))) return 'expired';
  return 'canceled';
}

/** El QR que se enseña: el de la tarjeta (el mismo del camarero); si no, el del saldo suelto. */
function qrOf(input: ScreenInput, openCard: boolean, openCharge: boolean): string | null {
  const { payment: p, charge: c, urls } = input;
  if (p && openCard) return p.captureMethod === 'POS_EXTERNAL' ? null : cardQrUrl(p, urls);
  if (c && openCharge && c.payToken) return `${urls.api}/s/${encodeURIComponent(c.payToken)}`;
  return null;
}

export function screenViewOf(input: ScreenInput): CustomerScreenView {
  const base = { venueName: input.venueName, fichas: input.fichas, pairedUntil: input.pairedUntil.toISOString() };
  const { payment: p, charge: c, now } = input;
  if (!p && !c) return { ...base, state: 'idle' };
  const key = displayKey(p?.id ?? null, c?.id ?? null);

  // Pagado con tarjeta, o con la ficha (el cobro del saldo aceptado: la tarjeta se canceló).
  if (cardPaid(p) || c?.status === 'ACCEPTED') return { ...base, state: 'paid', key };

  const openCard = p !== null && cardOpen(p, now);
  const openCharge = c !== null && chargeOpen(c, now);
  if (!openCard && !openCharge) return { ...base, state: 'ended', key, reason: endReason(input) };
  // Sin pagar y el camarero ya no está en ese cobro: reposo (no se deja un QR suelto).
  if (input.cleared) return { ...base, state: 'idle' };

  const paying = p !== null && openCard && CARD_PAYING.has(p.status);
  const amountCents = p?.amountCents ?? c?.amountCents ?? 0;
  const fee = p ? Math.max(0, p.serviceFeeCents) : 0;
  return {
    ...base,
    state: 'waiting',
    key,
    currency: p?.currency ?? 'EUR',
    amountCents,
    cardAmountCents: p && openCard && fee > 0 && p.captureMethod !== 'POS_EXTERNAL' ? amountCents + fee : null,
    qrUrl: paying ? null : qrOf(input, openCard, openCharge),
    ficha: input.fichas && openCharge,
    paying,
    topUp: Boolean(p?.walletId),
  };
}
