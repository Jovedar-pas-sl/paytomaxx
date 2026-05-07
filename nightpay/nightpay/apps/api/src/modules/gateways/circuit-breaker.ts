import CircuitBreaker from 'opossum';
import { Logger } from '@nestjs/common';

/**
 * Wrapper opossum + helpers comunes para gateway adapters (ADR-005).
 * - timeout configurable
 * - threshold 50% errores en ventana de 1 min
 * - resetTimeout 30s en estado open
 * - volumeThreshold 10 (no abrimos por 1-2 errores aislados)
 */

export type BreakerState = 'closed' | 'halfOpen' | 'open';

export interface BreakerOptions {
  timeoutMs: number;
  errorThresholdPercentage?: number;
  resetTimeoutMs?: number;
  volumeThreshold?: number;
  name: string;
  /** Optional callback fired on state transitions — used to wire Prometheus gauge. */
  onStateChange?: (state: BreakerState) => void;
}

export function createBreaker<TIn extends unknown[], TOut>(
  fn: (...args: TIn) => Promise<TOut>,
  opts: BreakerOptions,
): CircuitBreaker<TIn, TOut> {
  const logger = new Logger(`CircuitBreaker[${opts.name}]`);
  const breaker = new CircuitBreaker<TIn, TOut>(fn, {
    timeout: opts.timeoutMs,
    errorThresholdPercentage: opts.errorThresholdPercentage ?? 50,
    resetTimeout: opts.resetTimeoutMs ?? 30_000,
    volumeThreshold: opts.volumeThreshold ?? 10,
    rollingCountTimeout: 60_000,
    rollingCountBuckets: 10,
    name: opts.name,
  });
  breaker.on('open', () => {
    logger.warn(`OPEN`);
    opts.onStateChange?.('open');
  });
  breaker.on('halfOpen', () => {
    logger.log(`HALF-OPEN — probing`);
    opts.onStateChange?.('halfOpen');
  });
  breaker.on('close', () => {
    logger.log(`CLOSED`);
    opts.onStateChange?.('closed');
  });
  breaker.on('reject', () => logger.warn(`REJECTED (open) — request blocked`));
  breaker.on('timeout', () => logger.warn(`TIMEOUT after ${opts.timeoutMs}ms`));
  // Estado inicial (closed) — registramos el gauge desde el principio.
  opts.onStateChange?.('closed');
  return breaker;
}

/**
 * fetch con AbortSignal timeout. Lanza si supera el timeout o el server no responde.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wraps a breaker.fire() call with timing + outcome reporting.
 * `observe(durationSec, outcome)` is invoked exactly once per call.
 * outcome: 'ok' | 'error' | 'rejected' (rejected = breaker open).
 */
export async function timedFire<T>(
  fire: () => Promise<T>,
  observe: (durationSec: number, outcome: 'ok' | 'error' | 'rejected') => void,
): Promise<T> {
  const start = process.hrtime.bigint();
  try {
    const result = await fire();
    const dur = Number(process.hrtime.bigint() - start) / 1e9;
    observe(dur, 'ok');
    return result;
  } catch (err) {
    const dur = Number(process.hrtime.bigint() - start) / 1e9;
    const isRejected =
      err instanceof Error && /breaker is open|breaker has been opened/i.test(err.message);
    observe(dur, isRejected ? 'rejected' : 'error');
    throw err;
  }
}
