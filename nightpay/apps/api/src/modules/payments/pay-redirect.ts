import type { PaymentMachineState } from './payment.machine';
import { tipOptionsFor } from './tip';

/** Por qué un QR ya no se puede pagar (texto para el cliente en public-pay). */
export type PayClosedReason =
  | 'expired'
  | 'failed'
  | 'canceled'
  | 'unconfirmed'
  | 'too-many-attempts';

/** Botón que pulsa el cliente: Apple Pay / Google Pay o tarjeta. */
export type PayMethodChoice = 'wallet' | 'card';

/** Lo que elige el cliente en la página de pago antes de ir al banco. */
export interface CheckoutChoice {
  tipCents: number;
  method: PayMethodChoice | null;
  language: 'es' | 'en';
}

export type PayRedirect =
  | { kind: 'redirect'; url: string; status: PaymentMachineState }
  | {
      kind: 'form';
      action: string;
      method: 'POST';
      fields: Record<string, string>;
      status: PaymentMachineState;
    }
  | {
      /**
       * Pedido abierto: el controlador redirige (303) a /pay/:token/checkout,
       * que pinta el formulario hacia el banco. Así "atrás" o recargar no
       * reenvían el POST de la página de pago.
       */
      kind: 'checkout';
      order: string;
    }
  | {
      /** Página de pago: importe, propina y botones. Aún no hay nada en el banco. */
      kind: 'choose';
      amountCents: number;
      currency: string;
      tipOptionsCents: number[];
      tipCents: number;
      qrExpiresAt: Date;
    }
  | {
      kind: 'paid';
      paymentId: string;
      amountCents: number;
      tipCents: number;
      currency: string;
      authorizedAt: Date | null;
    }
  | { kind: 'processing' }
  | { kind: 'closed'; reason: PayClosedReason };

export interface PayResultView {
  paymentId: string;
  status: PaymentMachineState;
  amountCents: number;
  tipCents: number;
  currency: string;
  authorizedAt: Date | null;
  qrToken: string;
  /** Estado del intento concreto por el que vuelve el cliente (PENDING/APPROVED/DENIED). */
  attemptStatus: string | null;
}

/** Justificante del cliente: sin datos personales (ni nombre ni dígitos de tarjeta). */
export interface PayReceiptView {
  paymentId: string;
  amountCents: number;
  tipCents: number;
  currency: string;
  authorizedAt: Date | null;
  authCode: string | null;
  cardBrand: string | null;
  payMethod: PayMethodChoice | null;
  /** Pedido del banco (Ds_Order) del intento cobrado. */
  order: string | null;
}

export const PAID_STATES: ReadonlySet<PaymentMachineState> = new Set<PaymentMachineState>([
  'AUTHORIZED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
]);

export const CLOSED_REASON: Partial<Record<PaymentMachineState, PayClosedReason>> = {
  FAILED: 'failed',
  EXPIRED: 'expired',
  CANCELED: 'canceled',
  ORPHAN: 'unconfirmed',
};

/** Intentos de pago (pedidos Redsys) por QR. */
export const MAX_PAYMENT_ATTEMPTS = 3;

/**
 * Tiempo que se espera al aviso del banco antes de dar por abandonado un
 * intento sin respuesta. Las denegaciones llegan al momento (y permiten
 * reintentar ya); esto solo cuenta cuando no llega nada, y tiene que cubrir
 * a un cliente que sigue en la pantalla de 3D Secure de su banco para no
 * abrir un segundo pedido que también pudiera pagarse.
 */
export const RETRY_WAIT_MS = 150_000;

export type RetryDecision = 'retry' | 'wait' | 'expired' | 'max-attempts';

/**
 * Pago en AUTHORIZING por Redsys y el cliente vuelve a escanear el QR.
 *  - Último intento aprobado (aviso aún sin procesar) o pendiente reciente → esperar.
 *  - Denegado o abandonado → nuevo intento, si el QR sigue vigente y quedan intentos.
 * `attempts` va del más reciente al más antiguo. Sin intentos registrados
 * (pagos anteriores a Fase 0) cuenta como uno pendiente desde `paymentUpdatedAt`.
 */
export function decideRedsysRetry(args: {
  attempts: ReadonlyArray<{ status: string; createdAt: Date }>;
  now: Date;
  qrExpiresAt: Date;
  paymentUpdatedAt: Date;
}): RetryDecision {
  const latest = args.attempts[0];
  const latestStatus = latest?.status ?? 'PENDING';
  const latestAt = latest?.createdAt ?? args.paymentUpdatedAt;
  const count = Math.max(args.attempts.length, 1);

  if (latestStatus === 'APPROVED') return 'wait';
  if (latestStatus === 'PENDING' && args.now.getTime() - latestAt.getTime() < RETRY_WAIT_MS) {
    return 'wait';
  }
  if (args.qrExpiresAt <= args.now) return 'expired';
  if (count >= MAX_PAYMENT_ATTEMPTS) return 'max-attempts';
  return 'retry';
}

/** Lo que hace falta del cobro para decidir qué página ve el cliente. */
export interface PayablePayment {
  id: string;
  status: PaymentMachineState;
  amountCents: number;
  tipCents: number;
  currency: string;
  qrExpiresAt: Date;
  authorizedAt: Date | null;
  /** Propina solo con Redsys y fuera de recargas de wallet. */
  allowTip: boolean;
}

/**
 * Cobros que ya no van al banco: pagado, cerrado o QR caducado sin empezar.
 * `null` = se puede pagar (o hay un intento en curso).
 */
export function settledPayView(p: PayablePayment, now: Date = new Date()): PayRedirect | null {
  if (PAID_STATES.has(p.status)) {
    return {
      kind: 'paid',
      paymentId: p.id,
      amountCents: p.amountCents,
      tipCents: p.tipCents,
      currency: p.currency,
      authorizedAt: p.authorizedAt,
    };
  }
  const closed = CLOSED_REASON[p.status];
  if (closed) return { kind: 'closed', reason: closed };
  if (p.status !== 'AUTHORIZING' && p.qrExpiresAt <= now) return { kind: 'closed', reason: 'expired' };
  return null;
}

/** Página de pago con las propinas que se pueden elegir. */
export function choosePayPage(p: PayablePayment): PayRedirect {
  return {
    kind: 'choose',
    amountCents: p.amountCents,
    currency: p.currency,
    tipOptionsCents: tipOptionsFor({ tipCents: p.tipCents, allowTip: p.allowTip }),
    tipCents: p.tipCents,
    qrExpiresAt: p.qrExpiresAt,
  };
}

/**
 * Un pedido recién abierto se puede volver a enseñar durante este tiempo: un
 * doble toque o el paso del POST al formulario llevan al mismo pedido en vez
 * de abrir otro. Pasado, "atrás" vuelve a la página del cobro.
 */
export const CHECKOUT_REPLAY_MS = 30_000;

/**
 * Pedido del último intento si sigue pendiente y es reciente. `attempts` va
 * del más reciente al más antiguo.
 */
export function freshPendingOrder(
  attempts: ReadonlyArray<{ providerTxId: string; status: string; createdAt: Date }>,
  now: Date,
): string | null {
  const latest = attempts[0];
  if (!latest || latest.status !== 'PENDING') return null;
  return now.getTime() - latest.createdAt.getTime() < CHECKOUT_REPLAY_MS ? latest.providerTxId : null;
}

/** Qué ve el cliente cuando no toca abrir un intento nuevo. */
export function retryOutcome(decision: Exclude<RetryDecision, 'retry'>): PayRedirect {
  if (decision === 'wait') return { kind: 'processing' };
  return { kind: 'closed', reason: decision === 'expired' ? 'expired' : 'too-many-attempts' };
}

/**
 * Código corto que ven a la vez el cliente (pantalla "Pagado") y la chica
 * (su app). Una captura vieja o una página falsa no lo tienen.
 */
export function confirmationCode(paymentId: string): string {
  return paymentId.replace(/-/g, '').slice(-3).toUpperCase();
}
