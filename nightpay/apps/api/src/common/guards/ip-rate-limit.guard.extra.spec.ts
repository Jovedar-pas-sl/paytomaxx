import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IpRateLimit, IpRateLimitGuard, type IpRateLimitConfig } from './ip-rate-limit.guard';

const LOGIN: IpRateLimitConfig = { max: 2, windowSec: 60, scope: 'auth-login' };
const PIN: IpRateLimitConfig = { max: 2, windowSec: 60, scope: 'wallet-pin' };

/** Controlador de pega con el decorador real (lo lee un Reflector real). */
class AuthDummy {
  @IpRateLimit(LOGIN)
  login(): void {}

  @IpRateLimit(PIN)
  pin(): void {}

  libre(): void {}
}

function makeRedis(ttl = 42) {
  const store = new Map<string, number>();
  return {
    store,
    incr: vi.fn(async (k: string) => {
      const next = (store.get(k) ?? 0) + 1;
      store.set(k, next);
      return next;
    }),
    expire: vi.fn().mockResolvedValue(1),
    ttl: vi.fn().mockResolvedValue(ttl),
  };
}

function ctx(method: keyof AuthDummy, req: object, res: object = { header: vi.fn() }): ExecutionContext {
  return {
    getHandler: () => AuthDummy.prototype[method],
    getClass: () => AuthDummy,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

const desde = (ip: string) => ({ headers: {}, socket: { remoteAddress: ip } });

let redis: ReturnType<typeof makeRedis>;
let guard: IpRateLimitGuard;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-17T00:00:05Z'));
  redis = makeRedis();
  guard = new IpRateLimitGuard(new Reflector(), redis as never);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('IpRateLimitGuard — decorador real + Reflector real', () => {
  it('ruta sin @IpRateLimit: no toca Redis', async () => {
    await expect(guard.canActivate(ctx('libre', desde('83.45.120.7')))).resolves.toBe(true);
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it('cada scope cuenta aparte para la misma IP', async () => {
    const ip = desde('83.45.120.7');
    await guard.canActivate(ctx('login', ip));
    await guard.canActivate(ctx('login', ip));
    await expect(guard.canActivate(ctx('pin', ip))).resolves.toBe(true);
    await expect(guard.canActivate(ctx('login', ip))).rejects.toThrow(HttpException);
  });

  it('la clave lleva scope, IP (en IPv6, su red /64) y ventana', async () => {
    await guard.canActivate(ctx('login', desde('2a0c:5a80:1f02::1d')));
    const bucket = Math.floor(Date.parse('2026-10-17T00:00:05Z') / 1000 / 60);
    expect(redis.incr).toHaveBeenCalledWith(`nightpay:iprl:auth-login:2a0c:5a80:1f02:0::/64:${bucket}`);
  });
});

describe('IpRateLimitGuard — ventana fija', () => {
  it('al cambiar de ventana el contador vuelve a empezar', async () => {
    const ip = desde('83.45.120.7');
    await guard.canActivate(ctx('login', ip));
    await guard.canActivate(ctx('login', ip));
    await expect(guard.canActivate(ctx('login', ip))).rejects.toThrow(HttpException);
    vi.setSystemTime(new Date('2026-10-17T00:01:00Z'));
    await expect(guard.canActivate(ctx('login', ip))).resolves.toBe(true);
  });
});

describe('IpRateLimitGuard — respuesta 429', () => {
  async function agotar(res: object) {
    const ip = desde('83.45.120.7');
    await guard.canActivate(ctx('login', ip));
    await guard.canActivate(ctx('login', ip));
    return guard.canActivate(ctx('login', ip, res));
  }

  it('status 429 y Retry-After con el TTL que queda', async () => {
    const res = { header: vi.fn() };
    const err = await agotar(res).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect((err as HttpException).getResponse()).toMatchObject({ retryAfter: 42 });
    expect(res.header).toHaveBeenCalledWith('Retry-After', 42);
  });

  it('clave sin TTL (ttl -1) → Retry-After = la ventana entera', async () => {
    redis.ttl.mockResolvedValue(-1);
    const res = { header: vi.fn() };
    await expect(agotar(res)).rejects.toThrow(HttpException);
    expect(res.header).toHaveBeenCalledWith('Retry-After', 60);
  });

  it('respuesta sin header() (otro adaptador): sigue siendo 429', async () => {
    await expect(agotar({})).rejects.toThrow(HttpException);
  });
});

describe('IpRateLimitGuard — fallos', () => {
  it('sin IP de fiar: deja pasar sin contar (comportamiento actual)', async () => {
    await expect(guard.canActivate(ctx('login', { headers: {} }))).resolves.toBe(true);
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it('si Redis falla, el error sube (no se deja pasar en silencio)', async () => {
    redis.incr.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(guard.canActivate(ctx('login', desde('83.45.120.7')))).rejects.toThrow(/ECONNREFUSED/);
  });
});
