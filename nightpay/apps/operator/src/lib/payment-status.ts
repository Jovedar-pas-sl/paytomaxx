import type { PaymentStatus } from '@nightpay/contracts';

// El orden de los estados vive en @nightpay/ui (lo usa también el TPV).
export { advanceStatus, isFinalStatus } from '@nightpay/ui';

/** Lo que dice el sondeo de un cobro (GET /v1/payments/public/:qrToken). */
export interface PolledPayment {
  id: string;
  status: PaymentStatus;
  /** Propina que dejó el cliente: solo si ya está pagado y el API es nuevo. */
  tipCents?: number;
}

/**
 * La respuesta del sondeo, como la del tiempo real: el estado y, si el API la
 * da, la propina. Sin ella, no se inventa un 0 (la propina sigue sin saberse).
 * La de otro cobro no cuenta.
 */
export function pollUpdate(current: PolledPayment, id: string): { status: PaymentStatus; tipCents?: number } | null {
  if (current.id !== id) return null;
  return typeof current.tipCents === 'number' ? { status: current.status, tipCents: current.tipCents } : { status: current.status };
}
