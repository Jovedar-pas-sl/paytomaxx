import CircuitBreaker from 'opossum';
import { Logger } from '@nestjs/common';

/**
 * Wrapper opossum + helpers comunes para gateway adapters (ADR-005).
 * - timeout configurable
 * - threshold 50% errores en ventana de 1 min
 * - resetTimeout 30s en estado open
 * - volumeThreshold 10 (no abrimos por 1-2 errores aislados)
 */

export interface BreakerOptions {
  timeoutMs: number;
  errorThresholdPercentage?: number;
  resetTimeoutMs?: number;
  volumeThreshold?: number;
  name: string;
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
  breaker.on('open', () => logger.warn(`OPEN`));
  breaker.on('halfOpen', () => logger.log(`HALF-OPEN — probing`));
  breaker.on('close', () => logger.log(`CLOSED`));
  breaker.on('reject', () => logger.warn(`REJECTED (open) — request blocked`));
  breaker.on('timeout', () => logger.warn(`TIMEOUT after ${opts.timeoutMs}ms`));
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
