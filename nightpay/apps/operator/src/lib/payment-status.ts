import type { BitcoinPayState, PaymentStatus } from '@nightpay/contracts';
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
  /** Ya pagado: «wallet» = Apple Pay o Google Pay; «card» = tarjeta; «bitcoin» = con BTCPay. */
  payMethod?: PaidQrMethod;
  /** Paga con bitcoin (AUTHORIZING con su factura): si se puede cancelar. API nuevo. */
  bitcoin?: BitcoinPayState;
}

const BITCOIN_STATES: ReadonlySet<string> = new Set<BitcoinPayState>(['open', 'confirming', 'problem', 'closed']);

/** Cómo se pagó el QR: tarjeta, Apple Pay o Google Pay, o bitcoin (en la cartera del local). */
export type PaidQrMethod = 'card' | 'wallet' | 'bitcoin';

const PAID_QR_METHODS: ReadonlySet<string> = new Set<PaidQrMethod>(['card', 'wallet', 'bitcoin']);

/** Lo que el sondeo cuenta de cómo se pagó (para el PAGADO). */
export interface PaidCardFacts {
  payMethod?: PaidQrMethod;
}

/** Solo lo que el API dijo y con forma válida: nada se inventa. */
export function cardFactsOf(current: PolledPayment): PaidCardFacts {
  const method = current.payMethod as unknown;
  return typeof method === 'string' && PAID_QR_METHODS.has(method) ? { payMethod: method as PaidQrMethod } : {};
}

/**
 * La respuesta del sondeo, como la del tiempo real: el estado y, si el API la
 * da, la propina. Sin ella, no se inventa un 0 (la propina sigue sin saberse).
 * La de otro cobro no cuenta. Pagando (AUTHORIZING): el estado de su factura de
 * bitcoin, o null si paga en su banco (o el API es anterior y no lo dice). Y si
 * la factura se cerró sin pagarse ('closed'), también: el cobro vuelve a estar abierto.
 */
export function pollUpdate(
  current: PolledPayment,
  id: string,
): ({ status: PaymentStatus; tipCents?: number; attemptStartedAt?: string; bitcoin?: BitcoinPayState | null } & PaidCardFacts) | null {
  if (!isPolledPayment(current, id)) return null;
  const bitcoin = bitcoinStateOf(current.bitcoin);
  return {
    status: current.status,
    ...(typeof current.tipCents === 'number' ? { tipCents: current.tipCents } : {}),
    ...(typeof current.attemptStartedAt === 'string' ? { attemptStartedAt: current.attemptStartedAt } : {}),
    ...(current.status === 'AUTHORIZING' || bitcoin === 'closed' ? { bitcoin } : {}),
    ...cardFactsOf(current),
  };
}

/** Solo un estado que se conoce: lo demás, como si no pagara con bitcoin. */
function bitcoinStateOf(value: unknown): BitcoinPayState | null {
  return typeof value === 'string' && BITCOIN_STATES.has(value) ? (value as BitcoinPayState) : null;
}
