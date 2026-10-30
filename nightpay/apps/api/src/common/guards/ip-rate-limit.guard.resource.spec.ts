import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import { HttpException } from '@nestjs/common';
import { IpRateLimitGuard, type IpRateLimitConfig } from './ip-rate-limit.guard';

/**
 * El estado del pago de «Comprobando el pago» (GET /pay/:token/status y
 * /pay/result/status?op=): 30–50 clientes tras el wifi del local consultan a la
 * vez. Cada cobro tiene su cupo desde esa IP (`perKey`) y la IP un tope alto;
 * así no gastan el de las páginas ni se cortan unos a otros.
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

const BY_TOKEN: IpRateLimitConfig = { max: 50, windowSec: 60, scope: 'pay-status', perKey: { param: 'token', max: 5 } };
const BY_OP: IpRateLimitConfig = { max: 50, windowSec: 60, scope: 'pay-status', perKey: { query: 'op', max: 5 } };

function guardFor(config: IpRateLimitConfig, redis: ReturnType<typeof makeRedis>) {
  const reflector = new Reflector();
  reflector.getAllAndOverride = vi.fn().mockReturnValue(config);
  return new IpRateLimitGuard(reflector, redis as never);
}

function ctx(req: { params?: Record<string, string>; query?: Record<string, string> }, ip = '81.0.0.7') {
  const full = { headers: {}, ip, socket: { remoteAddress: ip }, ...req };
  return {
    getHandler: () => () => undefined,
    getClass: () => class Dummy {},
    switchToHttp: () => ({ getRequest: () => full, getResponse: () => ({ header: vi.fn() }) }),
  } as never;
}

async function hit(guard: IpRateLimitGuard, req: Parameters<typeof ctx>[0], ip?: string): Promise<number> {
  try {
    await guard.canActivate(ctx(req, ip));
    return 200;
  } catch (err) {
    return (err as HttpException).getStatus();
  }
}

describe('IpRateLimitGuard por IP + cobro (estado del pago)', () => {
  let redis: ReturnType<typeof makeRedis>;
  beforeEach(() => {
    redis = makeRedis();
  });

  it('diez cobros distintos desde el mismo wifi: cada uno con su cupo', async () => {
    const guard = guardFor(BY_TOKEN, redis);
    for (let c = 0; c < 10; c++) {
      for (let i = 0; i < 5; i++) expect(await hit(guard, { params: { token: `tok-${c}` } })).toBe(200);
    }
  });

  it('el mismo cobro desde esa IP: 5 por minuto, el 6.º 429; los demás siguen', async () => {
    const guard = guardFor(BY_TOKEN, redis);
    for (let i = 0; i < 5; i++) expect(await hit(guard, { params: { token: 'tok-a' } })).toBe(200);
    expect(await hit(guard, { params: { token: 'tok-a' } })).toBe(429);
    expect(await hit(guard, { params: { token: 'tok-b' } })).toBe(200);
  });

  it('por el pedido de la query (la vuelta del banco), igual', async () => {
    const guard = guardFor(BY_OP, redis);
    for (let i = 0; i < 5; i++) expect(await hit(guard, { query: { op: '000123ABC' } })).toBe(200);
    expect(await hit(guard, { query: { op: '000123ABC' } })).toBe(429);
    expect(await hit(guard, { query: { op: '000999XYZ' } })).toBe(200);
  });

  it('la IP tiene su tope aunque cada consulta sea de un cobro distinto (enumerar tokens no sale gratis)', async () => {
    const guard = guardFor(BY_TOKEN, redis);
    for (let i = 0; i < 50; i++) expect(await hit(guard, { params: { token: `t-${i}` } })).toBe(200);
    expect(await hit(guard, { params: { token: 't-nuevo' } })).toBe(429);
    // Otra IP, su propio cupo.
    expect(await hit(guard, { params: { token: 't-nuevo' } }, '81.0.0.8')).toBe(200);
  });

  it('el token o el pedido no quedan en claro en Redis (son secretos de un cobro)', async () => {
    const guard = guardFor(BY_TOKEN, redis);
    await hit(guard, { params: { token: 'secreto-del-qr' } });
    expect([...redis.store.keys()].some((k) => k.includes('secreto-del-qr'))).toBe(false);
    expect([...redis.store.keys()].some((k) => k.includes(':res:'))).toBe(true);
  });

  it('sin el token ni el pedido en la petición, cuenta solo la IP', async () => {
    const guard = guardFor(BY_OP, redis);
    expect(await hit(guard, { query: {} })).toBe(200);
    expect([...redis.store.keys()].every((k) => !k.includes(':res:'))).toBe(true);
  });
});
