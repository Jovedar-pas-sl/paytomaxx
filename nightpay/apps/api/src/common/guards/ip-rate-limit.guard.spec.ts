import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import { HttpException } from '@nestjs/common';
import { IpRateLimit, IpRateLimitGuard, type IpRateLimitConfig } from './ip-rate-limit.guard';

function makeRedis() {
  const store = new Map<string, number>();
  return {
    incr: vi.fn().mockImplementation(async (k: string) => {
      const next = (store.get(k) ?? 0) + 1;
      store.set(k, next);
      return next;
    }),
    expire: vi.fn().mockResolvedValue(1),
    ttl: vi.fn().mockResolvedValue(60),
  };
}

function makeCtx(meta: IpRateLimitConfig | undefined, ip = '203.0.113.5') {
  const headers: Record<string, string | string[] | undefined> = {};
  const req = { headers, ip };
  const res = { header: vi.fn() };
  return {
    getHandler: () => () => undefined,
    getClass: () => class Dummy {},
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
    _res: res,
    _meta: meta,
  } as never;
}

function makeReflector(meta: IpRateLimitConfig | undefined) {
  const r = new Reflector();
  r.getAllAndOverride = vi.fn().mockReturnValue(meta);
  return r;
}

describe('IpRateLimitGuard', () => {
  let redis: ReturnType<typeof makeRedis>;
  beforeEach(() => {
    redis = makeRedis();
  });

  it('is a no-op when no @IpRateLimit metadata is set', async () => {
    const guard = new IpRateLimitGuard(makeReflector(undefined), redis as never);
    const ctx = makeCtx(undefined);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it('allows requests under the limit', async () => {
    const config: IpRateLimitConfig = { max: 5, windowSec: 60, scope: 'test' };
    const guard = new IpRateLimitGuard(makeReflector(config), redis as never);
    for (let i = 0; i < 5; i++) {
      await expect(guard.canActivate(makeCtx(config))).resolves.toBe(true);
    }
    expect(redis.incr).toHaveBeenCalledTimes(5);
  });

  it('sets TTL on first hit only', async () => {
    const config: IpRateLimitConfig = { max: 5, windowSec: 60, scope: 'test' };
    const guard = new IpRateLimitGuard(makeReflector(config), redis as never);
    await guard.canActivate(makeCtx(config));
    await guard.canActivate(makeCtx(config));
    expect(redis.expire).toHaveBeenCalledTimes(1);
    expect(redis.expire).toHaveBeenCalledWith(expect.any(String), 60);
  });

  it('throws 429 when over the limit', async () => {
    const config: IpRateLimitConfig = { max: 2, windowSec: 60, scope: 'test' };
    const guard = new IpRateLimitGuard(makeReflector(config), redis as never);
    await guard.canActivate(makeCtx(config));
    await guard.canActivate(makeCtx(config));
    await expect(guard.canActivate(makeCtx(config))).rejects.toThrow(HttpException);
  });

  it('sets Retry-After header on 429', async () => {
    const config: IpRateLimitConfig = { max: 1, windowSec: 60, scope: 'test' };
    const guard = new IpRateLimitGuard(makeReflector(config), redis as never);
    await guard.canActivate(makeCtx(config));
    const ctx2 = makeCtx(config);
    await expect(guard.canActivate(ctx2)).rejects.toThrow(HttpException);
    expect(ctx2._res.header).toHaveBeenCalledWith('Retry-After', 60);
  });

  it('uses X-Forwarded-For when present (proxy-aware)', async () => {
    const config: IpRateLimitConfig = { max: 100, windowSec: 60, scope: 'test' };
    const guard = new IpRateLimitGuard(makeReflector(config), redis as never);
    const ctx = makeCtx(config);
    ctx.switchToHttp().getRequest().headers['x-forwarded-for'] = '198.51.100.42, 10.0.0.1';
    await guard.canActivate(ctx);
    const key = redis.incr.mock.calls[0][0];
    expect(key).toMatch(/198\.51\.100\.42/);
  });

  it('detrás de Cloudflare usa CF-Connecting-IP (X-Forwarded-For se puede falsear)', async () => {
    const config: IpRateLimitConfig = { max: 100, windowSec: 60, scope: 'test' };
    const guard = new IpRateLimitGuard(makeReflector(config), redis as never);
    const ctx = makeCtx(config);
    const headers = ctx.switchToHttp().getRequest().headers;
    headers['x-forwarded-for'] = '1.2.3.4';
    headers['cf-connecting-ip'] = '203.0.113.7';
    await guard.canActivate(ctx);
    const key = redis.incr.mock.calls.at(-1)[0];
    expect(key).toMatch(/203\.0\.113\.7/);
    expect(key).not.toMatch(/1\.2\.3\.4/);
  });

  it('isolates IPs in different Redis keys', async () => {
    const config: IpRateLimitConfig = { max: 1, windowSec: 60, scope: 'test' };
    const guard = new IpRateLimitGuard(makeReflector(config), redis as never);
    await guard.canActivate(makeCtx(config, '203.0.113.1'));
    // Different IP — should not throw despite max=1 globally.
    await expect(
      guard.canActivate(makeCtx(config, '203.0.113.2')),
    ).resolves.toBe(true);
  });
});

describe('IpRateLimit decorator', () => {
  it('attaches metadata that the guard reads', () => {
    const config = { max: 10, windowSec: 60, scope: 'auth-login' as const };
    const decorator = IpRateLimit(config);
    expect(typeof decorator).toBe('function');
  });
});

describe('clientIp (la IP que cuenta para el login y los límites)', () => {
  it('detrás de Cloudflare manda CF-Connecting-IP aunque el cliente invente X-Forwarded-For', async () => {
    const { clientIp } = await import('./ip-rate-limit.guard');
    const req = { headers: { 'cf-connecting-ip': '81.0.0.7', 'x-forwarded-for': '1.2.3.4, 81.0.0.7' } };
    expect(clientIp(req)).toBe('81.0.0.7');
    const otra = { headers: { 'cf-connecting-ip': '81.0.0.7', 'x-forwarded-for': '9.9.9.9' } };
    expect(clientIp(otra)).toBe('81.0.0.7');
  });

  it('sin Cloudflare (dev): X-Forwarded-For y si no, la del socket', async () => {
    const { clientIp } = await import('./ip-rate-limit.guard');
    expect(clientIp({ headers: { 'x-forwarded-for': '10.0.0.1, 10.0.0.2' } })).toBe('10.0.0.1');
    expect(clientIp({ headers: {}, socket: { remoteAddress: '127.0.0.1' } })).toBe('127.0.0.1');
  });
});
