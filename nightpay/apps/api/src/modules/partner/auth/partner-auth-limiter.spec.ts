import { afterEach, describe, it, expect, vi } from 'vitest';
import { createFakeRedis } from '../../auth/testing/fake-redis';
import { PAUTH_LIMITS, PartnerAuthLimiter, authIpKey } from './partner-auth-limiter';
import { PartnerRateLimiter } from './partner-rate-limit';

const h = (i: number) => i.toString(16).padStart(64, '0');

afterEach(() => vi.useRealTimers());

describe('fallos de autenticación (Redis, antes de la base)', () => {
  it('20 fallos de la misma clave en 10 min: esa clave queda bloqueada 15 min', async () => {
    const limiter = new PartnerAuthLimiter(createFakeRedis() as never);
    for (let i = 0; i < PAUTH_LIMITS.keyFails - 1; i++) await limiter.recordFailure(h(1), '203.0.113.9');
    expect((await limiter.state(h(1), '203.0.113.9')).keyBlocked).toBe(false);
    await limiter.recordFailure(h(1), '198.51.100.4');
    expect((await limiter.state(h(1), '203.0.113.9')).keyBlocked).toBe(true);
    expect((await limiter.state(h(2), '203.0.113.9')).keyBlocked).toBe(false);
  });

  it('una IP: 20 claves distintas en 10 min la bloquean; repetir la misma no cuenta otra vez', async () => {
    const limiter = new PartnerAuthLimiter(createFakeRedis() as never);
    for (let i = 0; i < 30; i++) await limiter.recordFailure(h(7), '203.0.113.9');
    expect((await limiter.state(h(8), '203.0.113.9')).ipBlocked).toBe(false);
    for (let i = 0; i < PAUTH_LIMITS.ipKeys - 1; i++) await limiter.recordFailure(h(100 + i), '203.0.113.9');
    expect((await limiter.state(h(8), '203.0.113.9')).ipBlocked).toBe(true);
    expect((await limiter.state(h(8), '203.0.113.10')).ipBlocked).toBe(false);
  });

  it('IPv6 cuenta por /48', async () => {
    expect(authIpKey('2001:db8:aa:1::1')).toBe(authIpKey('2001:db8:aa:ffff::9'));
    expect(authIpKey('2001:db8:aa:1::1')).not.toBe(authIpKey('2001:db8:ab:1::1'));
    expect(authIpKey('203.0.113.9')).toBe('203.0.113.9');
    expect(authIpKey(null)).toBe('desconocida');
  });

  it('el cortacircuitos salta con más de 600 fallos en un minuto (de IP distintas)', async () => {
    const limiter = new PartnerAuthLimiter(createFakeRedis() as never);
    for (let i = 0; i < PAUTH_LIMITS.breakerFails - 1; i++) await limiter.recordFailure(h(i), `198.51.${i >> 8}.${i & 255}`);
    expect((await limiter.state(h(9999), '203.0.113.1')).breaker).toBe(false);
    await limiter.recordFailure(h(9998), '203.0.113.2');
    expect((await limiter.state(h(9999), '203.0.113.1')).breaker).toBe(true);
  });

  it('700 claves inventadas desde una IP bloqueada no levantan el cortacircuitos (cada una, 429 sin contar)', async () => {
    const limiter = new PartnerAuthLimiter(createFakeRedis() as never);
    let refused = 0;
    for (let i = 0; i < 700; i++) {
      const state = await limiter.state(h(i), '203.0.113.66');
      if (state.ipBlocked) {
        refused += 1;
        continue;
      }
      await limiter.recordFailure(h(i), '203.0.113.66');
    }
    expect(refused).toBe(700 - PAUTH_LIMITS.ipKeys);
    expect((await limiter.state(h(5000), '198.51.100.1')).breaker).toBe(false);
  });

  it('con el cortacircuitos levantado, una clave que funcionó hace 2 h se reconoce', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-12-05T20:00:00Z'));
    const redis = createFakeRedis();
    const limiter = new PartnerAuthLimiter(redis as never);
    await limiter.markGood(h(42));
    vi.setSystemTime(new Date('2026-12-05T22:00:00Z'));
    for (let i = 0; i < PAUTH_LIMITS.breakerFails; i++) await limiter.recordFailure(h(i + 1000), `198.51.${i >> 8}.${i & 255}`);
    const state = await limiter.state(h(42), '203.0.113.1');
    expect(state.breaker).toBe(true);
    expect(state.known).toBe(true);
    vi.setSystemTime(new Date('2026-12-06T21:00:00Z'));
    expect((await limiter.state(h(42), '203.0.113.1')).known).toBe(false);
  });

  it('Redis caído: falla (el guard responde 503, nunca deja pasar a ciegas)', async () => {
    const redis = createFakeRedis();
    vi.spyOn(redis, 'mget').mockRejectedValueOnce(new Error('Connection is closed.'));
    await expect(new PartnerAuthLimiter(redis as never).state(h(1), '203.0.113.9')).rejects.toThrow(/closed/);
  });
});

describe('topes por conexión', () => {
  it('600 llamadas por minuto; las de dinero, además, 120', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-12-05T22:00:10Z'));
    const limiter = new PartnerRateLimiter(createFakeRedis() as never);
    for (let i = 0; i < 120; i++) expect((await limiter.hit('c1', true)).ok).toBe(true);
    const money = await limiter.hit('c1', true);
    expect(money).toEqual({ ok: false, retryAfter: 50 });
    for (let i = 0; i < 600 - 121; i++) expect((await limiter.hit('c1', false)).ok).toBe(true);
    expect((await limiter.hit('c1', false)).ok).toBe(false);
    expect((await limiter.hit('c2', false)).ok).toBe(true);
    vi.setSystemTime(new Date('2026-12-05T22:01:00Z'));
    expect((await limiter.hit('c1', true)).ok).toBe(true);
  });
});
