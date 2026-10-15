import { HttpException } from '@nestjs/common';
import type { RefundResult } from '@nightpay/contracts';

/**
 * Qué pasó con una devolución pedida a la pasarela.
 *  - succeeded: la pasarela la hizo.
 *  - rejected: seguro que NO se hizo (la rechazó, no devuelve por API o la
 *    llamada ni salió). La reserva se libera.
 *  - unknown: pudo hacerse o no (timeout, conexión cortada, 5xx…). La
 *    devolución queda PENDIENTE y reservada hasta que el dueño lo mire: si se
 *    liberase y se repitiera, el cliente cobraría dos veces.
 */
export type GatewayRefundOutcome =
  | { kind: 'succeeded'; providerRefundId: string }
  | { kind: 'rejected'; why: RejectedWhy; providerRefundId: string | null; reason: string }
  | { kind: 'unknown'; providerRefundId: string | null; reason: string };

export type RejectedWhy = 'declined' | 'unsupported' | 'not_sent';

/** Códigos con los que la petición no llegó a salir hacia la pasarela. */
const NOT_SENT_CODES: ReadonlySet<string> = new Set([
  // opossum: circuito abierto, semáforo lleno o apagado → no llama.
  'EOPENBREAKER',
  'ESEMLOCKED',
  'ESHUTDOWN',
  // Sin conexión establecida: no se envió nada.
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** Los adaptadores que no devuelven por API lo dicen así (no llaman a nada). */
const UNSUPPORTED_MESSAGE = /no implementad|no soportad|manual-required|not implemented|no expone refund/i;

/** 4xx con los que la pasarela pudo haberla hecho igualmente (repetida, timeout). */
const AMBIGUOUS_4XX: ReadonlySet<number> = new Set([408, 409]);

export function outcomeOfGatewayResult(result: RefundResult): GatewayRefundOutcome {
  if (result.status === 'SUCCEEDED') {
    return { kind: 'succeeded', providerRefundId: result.providerRefundId };
  }
  if (result.status === 'FAILED') {
    return {
      kind: 'rejected',
      why: 'declined',
      providerRefundId: result.providerRefundId,
      reason: 'la pasarela la rechazó',
    };
  }
  return { kind: 'unknown', providerRefundId: result.providerRefundId, reason: 'la pasarela la dejó pendiente' };
}

export function outcomeOfGatewayError(err: unknown): GatewayRefundOutcome {
  const reason = err instanceof Error ? err.message : String(err);
  const why = rejectedWhy(err);
  return why
    ? { kind: 'rejected', why, providerRefundId: null, reason }
    : { kind: 'unknown', providerRefundId: null, reason };
}

/** Motivo si es seguro que la devolución no se hizo; null si no se sabe. */
function rejectedWhy(err: unknown): RejectedWhy | null {
  if (!(err instanceof Error)) return null;
  if (UNSUPPORTED_MESSAGE.test(err.message)) return 'unsupported';
  const code = errorCode(err);
  if (code && NOT_SENT_CODES.has(code)) return 'not_sent';
  const status = httpStatusOf(err);
  if (status !== null && status >= 400 && status < 500 && !AMBIGUOUS_4XX.has(status)) return 'declined';
  return null;
}

function errorCode(err: Error): string | null {
  const own = (err as { code?: unknown }).code;
  if (typeof own === 'string') return own;
  const cause = (err as { cause?: { code?: unknown } }).cause;
  return typeof cause?.code === 'string' ? cause.code : null;
}

function httpStatusOf(err: Error): number | null {
  if (err instanceof HttpException) return err.getStatus();
  const e = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  const candidates = [e.status, e.statusCode, e.response?.status];
  const found = candidates.find((s): s is number => typeof s === 'number');
  return found ?? null;
}
