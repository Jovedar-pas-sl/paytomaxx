import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TotpMemoryGuard } from './totp-memory-guard';

const POLICY = { threshold: 5, windowSec: 15 * 60, lockSec: 15 * 60 };

describe('TotpMemoryGuard (API síncrona antigua)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T22:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('5 fallos bloquean 15 min; luego vuelve a dejar', () => {
    const guard = new TotpMemoryGuard(POLICY);
    for (let i = 0; i < 4; i++) expect(guard.recordFailure('k')).toBe(false);
    expect(guard.recordFailure('k')).toBe(true);
    expect(guard.lockedFor('k')).toBe(15 * 60);

    vi.advanceTimersByTime(15 * 60 * 1000);
    expect(guard.lockedFor('k')).toBe(0);
    // El contador empezó de cero al bloquear.
    expect(guard.recordFailure('k')).toBe(false);
  });

  it('los fallos de una ventana caducada no cuentan', () => {
    const guard = new TotpMemoryGuard(POLICY);
    for (let i = 0; i < 4; i++) guard.recordFailure('k');
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    expect(guard.recordFailure('k')).toBe(false);
  });

  it('un acierto pone los fallos a cero', () => {
    const guard = new TotpMemoryGuard(POLICY);
    for (let i = 0; i < 4; i++) guard.recordFailure('k');
    guard.clearFailures('k');
    expect(guard.recordFailure('k')).toBe(false);
  });

  it('un paso solo vale una vez y nunca uno anterior al último aceptado', () => {
    const guard = new TotpMemoryGuard(POLICY);
    expect(guard.claimStep('k', 100)).toBe(true);
    expect(guard.claimStep('k', 100)).toBe(false);
    expect(guard.claimStep('k', 99)).toBe(false);
    expect(guard.claimStep('k', 101)).toBe(true);
    // Cada secreto (clave) lleva su propia cuenta.
    expect(guard.claimStep('otra', 100)).toBe(true);
  });

  it('no crece sin límite: limpia entradas viejas', () => {
    const guard = new TotpMemoryGuard(POLICY, 3);
    guard.claimStep('a', 1);
    guard.claimStep('b', 1);
    guard.claimStep('c', 1);
    vi.advanceTimersByTime(60 * 60 * 1000);
    guard.claimStep('d', 999_999_999);
    expect(guard.size()).toBe(1);
  });
});
