import type { PaymentStatus } from '@nightpay/contracts';
import { isPolledPayment } from '@nightpay/ui';

// El orden de los estados vive en @nightpay/ui (lo usa también el TPV).
export { advanceStatus, isFinalStatus } from '@nightpay/ui';

/** Lo que dice el sondeo de un cobro (GET /v1/payments/public/:qrToken). */
export interface PolledPayment {
  /** Solo ya pagado: antes el API no lo da (de él sale el código del «Pagado»). */
  id?: string;
  status: PaymentStatus;
  /** Propina que dejó el cliente: solo si ya está pagado y el API es nuevo. */
  tipCents?: number;
  /** Esperando al banco (AUTHORIZING) o sin su respuesta (ORPHAN): cuándo salió el intento. API nuevo. */
  attemptStartedAt?: string | null;
  /** Ya pagado: las 4 últimas cifras de la tarjeta, si el banco las dio. */
  cardLast4?: string;
  /** Ya pagado: «wallet» = Apple Pay o Google Pay; «card» = tarjeta. */
  payMethod?: 'card' | 'wallet';
}

/** Lo que el sondeo cuenta de cómo se pagó (para el PAGADO). */
export interface PaidCardFacts {
  cardLast4?: string;
  payMethod?: 'card' | 'wallet';
}

/** Solo lo que el API dijo y con forma válida: nada se inventa. */
export function cardFactsOf(current: PolledPayment): PaidCardFacts {
  return {
    ...(typeof current.cardLast4 === 'string' && /^[0-9]{4}$/.test(current.cardLast4) ? { cardLast4: current.cardLast4 } : {}),
    ...(current.payMethod === 'card' || current.payMethod === 'wallet' ? { payMethod: current.payMethod } : {}),
  };
}

/**
 * La respuesta del sondeo, como la del tiempo real: el estado y, si el API la
 * da, la propina. Sin ella, no se inventa un 0 (la propina sigue sin saberse).
 * La de otro cobro no cuenta.
 */
export function pollUpdate(
  current: PolledPayment,
  id: string,
): ({ status: PaymentStatus; tipCents?: number; attemptStartedAt?: string } & PaidCardFacts) | null {
  if (!isPolledPayment(current, id)) return null;
  return {
    status: current.status,
    ...(typeof current.tipCents === 'number' ? { tipCents: current.tipCents } : {}),
    ...(typeof current.attemptStartedAt === 'string' ? { attemptStartedAt: current.attemptStartedAt } : {}),
    ...cardFactsOf(current),
  };
}
