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

function makeCtx(
  meta: IpRateLimitConfig | undefined,
  ip = '203.0.113.5',
  extra: { headers?: Record<string, string>; query?: Record<string, string>; body?: Record<string, string> } = {},
) {
  const headers: Record<string, string | string[] | undefined> = { ...extra.headers };
  // La conexión llega de `ip` (el socket); los tests de proxy pasan la de Traefik.
  const req = { headers, ip, socket: { remoteAddress: ip }, query: extra.query, body: extra.body };
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

  it('429 en el idioma de la página (?lang=, el lang del cuerpo o el del móvil) y con code estable', async () => {
    const config: IpRateLimitConfig = { max: 0, windowSec: 60, scope: 'test' };
    const guard = new IpRateLimitGuard(makeReflector(config), redis as never);
    const responseOf = async (extra: Parameters<typeof makeCtx>[2]) =>
      ((await guard.canActivate(makeCtx(config, '203.0.113.5', extra)).catch((e: unknown) => e)) as HttpException).getResponse();
    await expect(responseOf({ headers: { 'accept-language': 'es-ES,es;q=0.9' } })).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      message: 'Demasiados intentos seguidos: espera un momento y vuelve a probar.',
    });
    await expect(responseOf({ headers: { 'accept-language': 'de-DE' } })).resolves.toMatchObject({
      message: 'Too many attempts in a row: wait a moment and try again.',
    });
    // La página en inglés en un móvil en castellano: manda la página.
    await expect(responseOf({ headers: { 'accept-language': 'es-ES' }, query: { lang: 'en' } })).resolves.toMatchObject({
      message: expect.stringMatching(/^Too many/),
    });
    await expect(responseOf({ headers: { 'accept-language': 'en-GB' }, body: { lang: 'es' } })).resolves.toMatchObject({
      message: expect.stringMatching(/^Demasiados/),
    });
  });

  it('sets Retry-After header on 429', async () => {
    const config: IpRateLimitConfig = { max: 1, windowSec: 60, scope: 'test' };
    const guard = new IpRateLimitGuard(makeReflector(config), redis as never);
    await guard.canActivate(makeCtx(config));
    const ctx2 = makeCtx(config);
    await expect(guard.canActivate(ctx2)).rejects.toThrow(HttpException);
    expect(ctx2._res.header).toHaveBeenCalledWith('Retry-After', 60);
  });

  it('detrás del proxy interno (Traefik) cuenta el último salto de X-Forwarded-For', async () => {
    const config: IpRateLimitConfig = { max: 100, windowSec: 60, scope: 'test' };
    const guard = new IpRateLimitGuard(makeReflector(config), redis as never);
    const ctx = makeCtx(config, '10.0.1.7');
    ctx.switchToHttp().getRequest().headers['x-forwarded-for'] = '9.9.9.9, 198.51.100.42';
    await guard.canActivate(ctx);
    const key = redis.incr.mock.calls[0][0];
    expect(key).toMatch(/198\.51\.100\.42/);
    expect(key).not.toMatch(/9\.9\.9\.9/);
  });

  it('detrás de Cloudflare usa CF-Connecting-IP (el último salto es de Cloudflare)', async () => {
    const config: IpRateLimitConfig = { max: 100, windowSec: 60, scope: 'test' };
    const guard = new IpRateLimitGuard(makeReflector(config), redis as never);
    const ctx = makeCtx(config, '10.0.1.7');
    const headers = ctx.switchToHttp().getRequest().headers;
    headers['x-forwarded-for'] = '1.2.3.4, 172.70.1.2';
    headers['cf-connecting-ip'] = '203.0.113.7';
    await guard.canActivate(ctx);
    const key = redis.incr.mock.calls.at(-1)[0];
    expect(key).toMatch(/203\.0\.113\.7/);
    expect(key).not.toMatch(/1\.2\.3\.4/);
  });

  it('una CF-Connecting-IP inventada (sin pasar por Cloudflare) no cambia el contador', async () => {
    const config: IpRateLimitConfig = { max: 1, windowSec: 60, scope: 'test' };
    const guard = new IpRateLimitGuard(makeReflector(config), redis as never);
    const intento = (fake: string) => {
      const ctx = makeCtx(config, '10.0.1.7');
      const headers = ctx.switchToHttp().getRequest().headers;
      headers['x-forwarded-for'] = '198.51.100.42';
      headers['cf-connecting-ip'] = fake;
      return guard.canActivate(ctx);
    };
    await intento('1.1.1.1');
    await expect(intento('2.2.2.2')).rejects.toThrow(HttpException);
  });

  it('IPv6: cambiar de dirección dentro del mismo /64 no se salta el tope', async () => {
    const config: IpRateLimitConfig = { max: 2, windowSec: 60, scope: 'test' };
    const guard = new IpRateLimitGuard(makeReflector(config), redis as never);
    await guard.canActivate(makeCtx(config, '2001:db8:abcd:12::1'));
    await guard.canActivate(makeCtx(config, '2001:db8:abcd:12::2'));
    await expect(guard.canActivate(makeCtx(config, '2001:db8:abcd:12:ffff::3'))).rejects.toThrow(HttpException);
    // Otro /64, su propio cupo.
    await expect(guard.canActivate(makeCtx(config, '2001:db8:abcd:13::1'))).resolves.toBe(true);
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
  it('se sigue exportando desde aquí (el login la importa de este archivo)', async () => {
    const { clientIp } = await import('./ip-rate-limit.guard');
    const viaCloudflare = {
      headers: { 'cf-connecting-ip': '81.0.0.7', 'x-forwarded-for': '1.2.3.4, 162.158.0.9' },
      socket: { remoteAddress: '10.0.1.7' },
    };
    expect(clientIp(viaCloudflare)).toBe('81.0.0.7');
    // Más casos en common/http/client-ip.spec.ts.
    expect(clientIp({ headers: {}, socket: { remoteAddress: '127.0.0.1' } })).toBe('127.0.0.1');
  });
});
