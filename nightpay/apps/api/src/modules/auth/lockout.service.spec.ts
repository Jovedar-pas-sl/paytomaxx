import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_POLICY, LockoutService, PER_IP_POLICY } from './lockout.service';
import { createFakeRedis, type FakeRedis } from './testing/fake-redis';

function makeService(): { svc: LockoutService; redis: FakeRedis } {
  const redis = createFakeRedis();
  return { svc: new LockoutService(redis as never), redis };
}

async function fail(svc: LockoutService, key: string, times: number, policy = PER_IP_POLICY) {
  let last = { count: 0, locked: false };
  for (let i = 0; i < times; i++) last = await svc.recordFailure(key, policy);
  return last;
}

describe('LockoutService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T22:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('por IP: 5 fallos en 15 min bloquean 15 min', async () => {
    const { svc } = makeService();
    expect((await fail(svc, 'a@b.es|1.2.3.4', 4)).locked).toBe(false);
    expect((await svc.isLocked('a@b.es|1.2.3.4')).locked).toBe(false);

    expect((await fail(svc, 'a@b.es|1.2.3.4', 1)).locked).toBe(true);
    const lock = await svc.isLocked('a@b.es|1.2.3.4');
    expect(lock.locked).toBe(true);
    expect(lock.ttlSeconds).toBe(PER_IP_POLICY.lockSec);

    vi.advanceTimersByTime(PER_IP_POLICY.lockSec * 1000 + 1);
    expect((await svc.isLocked('a@b.es|1.2.3.4')).locked).toBe(false);
  });

  it('la ventana es fija desde el primer fallo: fallos sueltos no la alargan', async () => {
    const { svc } = makeService();
    await fail(svc, 'k', 4);
    vi.advanceTimersByTime(PER_IP_POLICY.windowSec * 1000 + 1);
    // La ventana caducó: el contador vuelve a empezar.
    expect(await svc.recordFailure('k')).toEqual({ count: 1, locked: false });
  });

  it('cuenta: bloqueo corto (5 min) que NO se alarga con más fallos', async () => {
    const { svc } = makeService();
    expect((await fail(svc, 'cuenta:a@b.es', ACCOUNT_POLICY.threshold, ACCOUNT_POLICY)).locked).toBe(true);
    expect(ACCOUNT_POLICY.lockSec).toBe(5 * 60);

    vi.advanceTimersByTime(4 * 60 * 1000);
    // Más fallos mientras dura (p. ej. desde IPs nuevas) no lo renuevan.
    await fail(svc, 'cuenta:a@b.es', ACCOUNT_POLICY.threshold, ACCOUNT_POLICY);
    const lock = await svc.isLocked('cuenta:a@b.es');
    expect(lock.ttlSeconds).toBeLessThanOrEqual(60);

    vi.advanceTimersByTime(60 * 1000 + 1);
    expect((await svc.isLocked('cuenta:a@b.es')).locked).toBe(false);
  });

  it('al bloquear se pone el contador a cero: volver a bloquear exige otra tanda entera', async () => {
    const { svc } = makeService();
    await fail(svc, 'cuenta:a@b.es', ACCOUNT_POLICY.threshold, ACCOUNT_POLICY);
    vi.advanceTimersByTime(ACCOUNT_POLICY.lockSec * 1000 + 1);

    expect(await svc.recordFailure('cuenta:a@b.es', ACCOUNT_POLICY)).toEqual({ count: 1, locked: false });
    expect((await svc.isLocked('cuenta:a@b.es')).locked).toBe(false);
  });

  it('clear borra contador y bloqueo', async () => {
    const { svc, redis } = makeService();
    await fail(svc, 'k', 5);
    await svc.clear('k');
    expect((await svc.isLocked('k')).locked).toBe(false);
    expect(redis.keys().filter((k) => k.includes(':k'))).toEqual([]);
  });

  it('pareja email|IP de confianza durante 30 días tras un login correcto', async () => {
    const { svc } = makeService();
    expect(await svc.isTrusted('a@b.es|1.2.3.4')).toBe(false);
    await svc.markTrusted('a@b.es|1.2.3.4');
    expect(await svc.isTrusted('a@b.es|1.2.3.4')).toBe(true);
    expect(await svc.isTrusted('a@b.es|5.6.7.8')).toBe(false);

    vi.advanceTimersByTime(31 * 24 * 60 * 60 * 1000);
    expect(await svc.isTrusted('a@b.es|1.2.3.4')).toBe(false);
  });
});

describe('LockoutService.reserveAttempt (el intento se cuenta antes de mirar la contraseña)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T22:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  const ip = { key: 'a@b.es|1.2.3.4', policy: PER_IP_POLICY };
  const account = { key: 'cuenta:a@b.es', policy: ACCOUNT_POLICY };

  it('cuenta en todas las claves; el quinto deja la IP bloqueada y el sexto ya no pasa', async () => {
    const { svc } = makeService();
    for (let i = 1; i <= 4; i++) expect(await svc.reserveAttempt([ip, account])).toEqual({ allowed: true, counts: [i, i] });
    expect(await svc.reserveAttempt([ip, account])).toEqual({ allowed: true, counts: [5, 5] });
    expect((await svc.isLocked(ip.key)).ttlSeconds).toBe(PER_IP_POLICY.lockSec);
    expect(await svc.reserveAttempt([ip, account])).toEqual({
      allowed: false,
      gate: 0,
      ttlSeconds: PER_IP_POLICY.lockSec,
    });
  });

  it('muchas a la vez: solo pasan tantas como el umbral', async () => {
    const { svc } = makeService();
    const all = await Promise.all(Array.from({ length: 50 }, () => svc.reserveAttempt([ip, account])));
    expect(all.filter((r) => r.allowed)).toHaveLength(PER_IP_POLICY.threshold);
  });

  it('una clave bloqueada que cuenta → no se cuenta en ninguna', async () => {
    const { svc, redis } = makeService();
    await svc.reserveAttempt([ip, account]);
    await redis.set(`nightpay:lockout:locked:${account.key}`, '1', 'EX', 120);
    expect(await svc.reserveAttempt([ip, account])).toEqual({ allowed: false, gate: 1, ttlSeconds: 120 });
    expect(await redis.get(`nightpay:lockout:fail:${ip.key}`)).toBe('1');
  });

  it('enforce: false (IP de confianza) → pasa aunque la cuenta esté bloqueada, y se cuenta', async () => {
    const { svc, redis } = makeService();
    await redis.set(`nightpay:lockout:locked:${account.key}`, '1', 'EX', 120);
    expect(await svc.reserveAttempt([ip, { ...account, enforce: false }])).toEqual({ allowed: true, counts: [1, 1] });
  });

  it('clear tras un acierto borra el intento reservado y el bloqueo', async () => {
    const { svc } = makeService();
    for (let i = 0; i < 5; i++) await svc.reserveAttempt([ip]);
    await svc.clear(ip.key);
    expect(await svc.reserveAttempt([ip])).toEqual({ allowed: true, counts: [1] });
  });
});
