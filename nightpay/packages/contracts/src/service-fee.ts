import { z } from 'zod';
import { formatMoney } from './money';

/**
 * «Comisión del servicio» (2026-10-26): lo que paga el CLIENTE encima del
 * precio. Es el ingreso de OxioPay: el dinero entra entero al local (su banco
 * o su caja) y la comisión se apunta como «se debe a OxioPay». Solo con el
 * interruptor del local encendido (venues.serviceFeeEnabled: lo enciende el
 * super-admin con 2FA, apagado de fábrica):
 *
 *  - Pago directo con tarjeta (QR /pay con tarjeta, Apple Pay o Google Pay, y
 *    venta en el datáfono): importe + % (venues.serviceFeeBps). La propina va
 *    aparte y no lleva comisión.
 *  - Recarga del saldo (tarjeta o efectivo): recarga + % (venues.topUpServiceFeeBps).
 *    El saldo es la recarga; la comisión no es saldo.
 *  - Gastar del saldo (NFC, PIN, Face ID, /s): sin comisión (ya se cobró al recargar).
 *  - Devolver saldo: solo el saldo (la comisión de la recarga se la queda OxioPay).
 *  - Devolución de un pago directo: también su comisión, en proporción.
 *
 * Con el interruptor encendido el local ya no paga el % antiguo de la
 * plataforma (platformCommissionBps) sobre esas ventas. Apagado: todo como antes.
 * Cada cobro y cada recarga guardan el % y el importe del momento.
 */

/** El nombre, igual en todas partes (cliente, personal, panel, informes). */
export const SERVICE_FEE_LABEL = 'Comisión del servicio';
/** En medio de una frase: «33 € + 3,30 € comisión del servicio». */
export const SERVICE_FEE_TEXT = 'comisión del servicio';

/** Hasta el 12 %. */
export const MAX_SERVICE_FEE_BPS = 1200;
/** De fábrica, el 10 % (en los locales nuevos y en los de antes al encenderla). */
export const DEFAULT_SERVICE_FEE_BPS = 1000;

export const ServiceFeeBpsSchema = z.number().int().min(0).max(MAX_SERVICE_FEE_BPS);

/** Lo del local: el interruptor y los dos %. */
export interface VenueServiceFee {
  /** «Comisión del servicio al cliente» (apagado de fábrica). */
  enabled: boolean;
  /** % de los pagos directos con tarjeta y del datáfono (bps). */
  cardBps: number;
  /** % de las recargas del saldo, con tarjeta o en efectivo (bps). */
  topUpBps: number;
}

export const SERVICE_FEE_OFF: VenueServiceFee = Object.freeze({
  enabled: false,
  cardBps: DEFAULT_SERVICE_FEE_BPS,
  topUpBps: DEFAULT_SERVICE_FEE_BPS,
});

export const VenueServiceFeeSchema = z.object({
  enabled: z.boolean(),
  cardBps: ServiceFeeBpsSchema,
  topUpBps: ServiceFeeBpsSchema,
});

/** A qué se aplica: un pago directo con tarjeta (o datáfono) o una recarga del saldo. */
export type ServiceFeeKind = 'card' | 'topUp';

/** La comisión de un importe, al céntimo (la mitad, hacia arriba). Nunca negativa. */
export function serviceFeeCents(amountCents: number, bps: number): number {
  if (!Number.isFinite(amountCents) || !Number.isFinite(bps) || amountCents <= 0 || bps <= 0) return 0;
  return Math.round((amountCents * bps) / 10_000);
}

/** El % que se aplica ahora; null = sin comisión (el interruptor apagado). */
export function serviceFeeBpsFor(fee: VenueServiceFee | null | undefined, kind: ServiceFeeKind): number | null {
  if (!fee?.enabled) return null;
  return kind === 'card' ? fee.cardBps : fee.topUpBps;
}

/** Lo que paga el cliente por un importe: el %, la comisión y el total (sin propina). */
export function serviceFeeQuote(
  fee: VenueServiceFee | null | undefined,
  kind: ServiceFeeKind,
  amountCents: number,
): { bps: number | null; feeCents: number; totalCents: number } {
  const bps = serviceFeeBpsFor(fee, kind);
  const feeCents = bps === null ? 0 : serviceFeeCents(amountCents, bps);
  return { bps, feeCents, totalCents: amountCents + feeCents };
}

/**
 * Lo que dice el API a las apps (GET /v1/venues/me → serviceFee, las opciones
 * de la recepción…). Sin el campo (API anterior) o con algo raro: apagado, así
 * una app nunca enseña ni cobra una comisión que el servidor no apunta.
 */
export function serviceFeeOf(raw: unknown): VenueServiceFee {
  const parsed = VenueServiceFeeSchema.safeParse(raw);
  return parsed.success ? parsed.data : SERVICE_FEE_OFF;
}

/**
 * La parte de una devolución que es comisión del servicio. Como el descuento a
 * la chica (refund-share), por lo acumulado: tras devolver `refundedAfterCents`
 * de lo cobrado (`chargedCents` = importe + comisión + propina), lo devuelto de
 * la comisión es round(comisión × devuelto / cobrado); esta devolución lleva lo
 * que falta sobre lo ya devuelto (`feeRefundedBeforeCents`). Si se devuelve
 * todo, la comisión entera, sin céntimos sueltos.
 */
export function refundServiceFeePart(args: {
  feeCents: number;
  chargedCents: number;
  refundedAfterCents: number;
  feeRefundedBeforeCents: number;
}): number {
  const { feeCents, chargedCents } = args;
  if (feeCents <= 0 || chargedCents <= 0) return 0;
  const refunded = Math.min(Math.max(0, args.refundedAfterCents), chargedCents);
  const expected = Math.round((feeCents * refunded) / chargedCents);
  return Math.max(0, Math.min(expected, feeCents) - Math.max(0, args.feeRefundedBeforeCents));
}

const short = (cents: number): string => formatMoney(cents, { compact: true });

/** «33 € + 3,30 € comisión del servicio + 2 € propina» (lo que no hay, no sale). */
export function chargeBreakdownText(parts: { baseCents: number; feeCents: number; tipCents: number }): string {
  return [
    short(parts.baseCents),
    ...(parts.feeCents > 0 ? [`${short(parts.feeCents)} ${SERVICE_FEE_TEXT}`] : []),
    ...(parts.tipCents > 0 ? [`${short(parts.tipCents)} propina`] : []),
  ].join(' + ');
}

/** Recepción: «Cobra 56 € (50 € de saldo + 6 € de comisión del servicio)»; sin comisión, «Cobra 50 €». */
export function topUpChargeText(topUpCents: number, feeCents: number): string {
  if (feeCents <= 0) return `Cobra ${short(topUpCents)}`;
  return `Cobra ${short(topUpCents + feeCents)} (${short(topUpCents)} de saldo + ${short(feeCents)} de ${SERVICE_FEE_TEXT})`;
}
