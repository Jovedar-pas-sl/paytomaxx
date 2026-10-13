import type { PaymentMachineState } from './payment.machine';

/** Por qué un QR ya no se puede pagar (texto para el cliente en public-pay). */
export type PayClosedReason =
  | 'expired'
  | 'failed'
  | 'canceled'
  | 'unconfirmed'
  | 'too-many-attempts';

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
      kind: 'paid';
      paymentId: string;
      amountCents: number;
      currency: string;
      authorizedAt: Date | null;
    }
  | { kind: 'processing' }
  | { kind: 'closed'; reason: PayClosedReason };

export interface PayResultView {
  paymentId: string;
  status: PaymentMachineState;
  amountCents: number;
  currency: string;
  authorizedAt: Date | null;
  qrToken: string;
  /** Estado del intento concreto por el que vuelve el cliente (PENDING/APPROVED/DENIED). */
  attemptStatus: string | null;
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

/**
 * Código corto que ven a la vez el cliente (pantalla "Pagado") y la chica
 * (su app). Una captura vieja o una página falsa no lo tienen.
 */
export function confirmationCode(paymentId: string): string {
  return paymentId.replace(/-/g, '').slice(-3).toUpperCase();
}
