import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import { LockoutService } from './lockout.service';
import { CLAIM_STEP_LUA, TOTP_LOCK_POLICY, TotpAttemptsService } from './totp-attempts.service';
import { claimStepScript, createFakeRedis } from './testing/fake-redis';

function makeService() {
  const redis = createFakeRedis();
  redis.defineScript(CLAIM_STEP_LUA, claimStepScript);
  const lockout = new LockoutService(redis as never);
  return { svc: new TotpAttemptsService(lockout, redis as never), redis };
}

describe('TotpAttemptsService (Redis, por usuario)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T22:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('5 fallos en 15 min → 429 durante 15 min', async () => {
    const { svc } = makeService();
    for (let i = 0; i < 4; i++) expect(await svc.recordFailure('u1')).toBe(false);
    await expect(svc.assertNotLocked('u1')).resolves.toBeUndefined();
    expect(await svc.recordFailure('u1')).toBe(true);

    const err = await svc.assertNotLocked('u1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);

    vi.advanceTimersByTime(TOTP_LOCK_POLICY.lockSec * 1000 + 1);
    await expect(svc.assertNotLocked('u1')).resolves.toBeUndefined();
  });

  it('el bloqueo es por usuario', async () => {
    const { svc } = makeService();
    for (let i = 0; i < 5; i++) await svc.recordFailure('u1');
    await expect(svc.assertNotLocked('u2')).resolves.toBeUndefined();
  });

  it('un acierto pone los fallos a cero', async () => {
    const { svc } = makeService();
    for (let i = 0; i < 4; i++) await svc.recordFailure('u1');
    await svc.clearFailures('u1');
    expect(await svc.recordFailure('u1')).toBe(false);
  });

  it('claimStep: cada paso una vez, nunca uno anterior; olvidar al desactivar', async () => {
    const { svc } = makeService();
    expect(await svc.claimStep('u1', 500)).toBe(true);
    expect(await svc.claimStep('u1', 500)).toBe(false);
    expect(await svc.claimStep('u1', 499)).toBe(false);
    expect(await svc.claimStep('u2', 500)).toBe(true);
    expect(await svc.claimStep('u1', 501)).toBe(true);

    await svc.forgetSteps('u1');
    expect(await svc.claimStep('u1', 400)).toBe(true);
  });

  it('el último paso caduca solo (no se queda en Redis para siempre)', async () => {
    const { svc, redis } = makeService();
    await svc.claimStep('u1', 500);
    expect(redis.keys()).toContain('nightpay:totp:last:u1');
    vi.advanceTimersByTime(11 * 60 * 1000);
    expect(redis.keys()).not.toContain('nightpay:totp:last:u1');
  });
});
