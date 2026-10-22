import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { HttpException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRateLimit, UserRateLimitGuard } from './user-rate-limit.guard';

class Ctrl {
  @UserRateLimit({ max: 2, windowSec: 60, scope: 'prueba' })
  limited(): void {}
  free(): void {}
}

function ctx(handler: () => void, user?: { sub: string }) {
  const header = vi.fn();
  return {
    header,
    ctx: { getHandler: () => handler, getClass: () => Ctrl, switchToHttp: () => ({ getRequest: () => ({ user }), getResponse: () => ({ header }) }) } as unknown as ExecutionContext,
  };
}

function redis() {
  const counts = new Map<string, number>();
  return { incr: vi.fn(async (k: string) => { counts.set(k, (counts.get(k) ?? 0) + 1); return counts.get(k)!; }), expire: vi.fn(async () => 1), ttl: vi.fn(async () => 42) };
}

describe('tope por persona', () => {
  it('cuenta por persona, no por IP: la tercera en el minuto, 429 con Retry-After', async () => {
    const r = redis();
    const guard = new UserRateLimitGuard(new Reflector(), r as never);
    const a = ctx(Ctrl.prototype.limited, { sub: 'u-1' });
    await expect(guard.canActivate(a.ctx)).resolves.toBe(true);
    await expect(guard.canActivate(a.ctx)).resolves.toBe(true);
    const err = await guard.canActivate(a.ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect(a.header).toHaveBeenCalledWith('Retry-After', 42);
    await expect(guard.canActivate(ctx(Ctrl.prototype.limited, { sub: 'u-2' }).ctx)).resolves.toBe(true);
    expect(r.incr.mock.calls[0]?.[0]).toMatch(/^nightpay:userrl:prueba:u-1:\d+$/);
  });
  it('sin el decorador o sin persona, no hace nada', async () => {
    const r = redis();
    const guard = new UserRateLimitGuard(new Reflector(), r as never);
    await expect(guard.canActivate(ctx(Ctrl.prototype.free, { sub: 'u-1' }).ctx)).resolves.toBe(true);
    await expect(guard.canActivate(ctx(Ctrl.prototype.limited).ctx)).resolves.toBe(true);
    expect(r.incr).not.toHaveBeenCalled();
  });
});
