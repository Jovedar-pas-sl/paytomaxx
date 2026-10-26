import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import { HttpException } from '@nestjs/common';
import { IpRateLimitGuard, type IpRateLimitConfig } from './ip-rate-limit.guard';

/**
 * Login por IP + cuenta (SEC-02): todo el personal de un local sale por la
 * misma IP; al abrir el turno, 10 inicios de sesión por minuto y por IP daban
 * 429. Ahora cada cuenta tiene su cupo desde esa IP y la IP un tope más alto.
 */

function makeRedis() {
  const store = new Map<string, number>();
  return {
    store,
    incr: vi.fn(async (k: string) => {
      const next = (store.get(k) ?? 0) + 1;
      store.set(k, next);
      return next;
    }),
    expire: vi.fn(async () => 1),
    ttl: vi.fn(async () => 42),
  };
}

const LOGIN: IpRateLimitConfig = { max: 30, windowSec: 60, scope: 'auth-login', perAccount: { field: 'email', max: 10 } };

function guardFor(config: IpRateLimitConfig, redis: ReturnType<typeof makeRedis>) {
  const reflector = new Reflector();
  reflector.getAllAndOverride = vi.fn().mockReturnValue(config);
  return new IpRateLimitGuard(reflector, redis as never);
}

function ctx(body: unknown, ip = '81.0.0.7') {
  const req = { headers: {}, ip, socket: { remoteAddress: ip }, body };
  const res = { header: vi.fn() };
  return {
    getHandler: () => () => undefined,
    getClass: () => class Dummy {},
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as never;
}

async function attempt(guard: IpRateLimitGuard, body: unknown, ip?: string): Promise<number> {
  try {
    await guard.canActivate(ctx(body, ip));
    return 200;
  } catch (err) {
    return (err as HttpException).getStatus();
  }
}

describe('IpRateLimitGuard por IP + cuenta (login)', () => {
  let redis: ReturnType<typeof makeRedis>;
  beforeEach(() => {
    redis = makeRedis();
  });

  it('30 personas distintas del mismo local entran en el mismo minuto', async () => {
    const guard = guardFor(LOGIN, redis);
    for (let i = 0; i < 30; i++) expect(await attempt(guard, { email: `chica${i}@local.es`, password: 'x' })).toBe(200);
  });

  it('una misma cuenta desde esa IP: 10 por minuto, la 11.ª 429 (y las demás cuentas siguen)', async () => {
    const guard = guardFor(LOGIN, redis);
    for (let i = 0; i < 10; i++) expect(await attempt(guard, { email: 'Ana@Local.es ', password: 'x' })).toBe(200);
    // Mayúsculas y espacios no dan un cupo nuevo.
    expect(await attempt(guard, { email: 'ana@local.es', password: 'x' })).toBe(429);
    expect(await attempt(guard, { email: 'otra@local.es', password: 'x' })).toBe(200);
  });

  it('la IP entera tiene su tope (más alto): muchas cuentas no lo saltan', async () => {
    const guard = guardFor(LOGIN, redis);
    for (let i = 0; i < 30; i++) await attempt(guard, { email: `c${i}@x.es` });
    expect(await attempt(guard, { email: 'nueva@x.es' })).toBe(429);
    // Otra IP, como siempre, va aparte.
    expect(await attempt(guard, { email: 'nueva@x.es' }, '81.0.0.8')).toBe(200);
  });

  it('sin cuenta en el cuerpo (o no es texto) cuenta solo la IP', async () => {
    const guard = guardFor(LOGIN, redis);
    expect(await attempt(guard, undefined)).toBe(200);
    expect(await attempt(guard, { email: ['a', 'b'] })).toBe(200);
    expect([...redis.store.keys()].filter((k) => k.includes(':acct:'))).toEqual([]);
  });

  it('la cuenta no se guarda en claro en Redis', async () => {
    const guard = guardFor(LOGIN, redis);
    await attempt(guard, { email: 'ana@local.es' });
    const keys = [...redis.store.keys()].join(' ');
    expect(keys).toContain(':acct:');
    expect(keys).not.toContain('ana@local.es');
  });
});
