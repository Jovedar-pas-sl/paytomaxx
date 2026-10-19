import { describe, it, expect, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import { DeviceRateLimitGuard } from './device-rate-limit.guard';
import type { PosDevice } from './device.guard';

const device: PosDevice = { terminalId: 'term-1', tenantId: 't-1', label: 'Recepción', zone: null, tokenHash: 'h' };

function make(config: { max: number; windowSec: number; scope: string } | undefined, posDevice: PosDevice | null = device) {
  let count = 0;
  const redis = { incr: vi.fn(async () => (count += 1)), expire: vi.fn(async () => 1) };
  const reflector = { getAllAndOverride: vi.fn(() => config) };
  const audit = { log: vi.fn(async () => undefined) };
  const guard = new DeviceRateLimitGuard(reflector as never, redis as never, audit as never);
  const ctx = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ posDevice: posDevice ?? undefined }) }),
  };
  return { call: () => guard.canActivate(ctx as never), redis, audit };
}

describe('tope por datáfono, venga de la IP que venga (seguridad #3)', () => {
  it('cuenta por datáfono; pasado el tope 429 y se apunta una sola vez por ventana', async () => {
    const { call, redis, audit } = make({ max: 2, windowSec: 60, scope: 'pos-reception-topup' });
    await expect(call()).resolves.toBe(true);
    await expect(call()).resolves.toBe(true);
    await expect(call()).rejects.toBeInstanceOf(HttpException);
    await expect(call()).rejects.toMatchObject({ status: 429 });
    expect(redis.incr.mock.calls[0]![0]).toMatch(/^nightpay:devrl:pos-reception-topup:term-1:\d+$/);
    expect(redis.expire).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'pos.reception_limit_exceeded',
        tenantId: 't-1',
        targetId: 'term-1',
        payload: expect.objectContaining({ limit: 'rate', max: 2, terminalLabel: 'Recepción' }),
      }),
    );
  });

  it('sin tope en el handler no hace nada; sin datáfono delante (falta DeviceGuard) → 401', async () => {
    const none = make(undefined);
    await expect(none.call()).resolves.toBe(true);
    expect(none.redis.incr).not.toHaveBeenCalled();
    await expect(make({ max: 1, windowSec: 60, scope: 's' }, null).call()).rejects.toMatchObject({ status: 401 });
  });
});
