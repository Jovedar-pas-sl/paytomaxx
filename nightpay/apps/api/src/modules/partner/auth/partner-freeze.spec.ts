import { describe, it, expect, vi } from 'vitest';
import { createFakeRedis } from '../../auth/testing/fake-redis';
import { FREEZE_CACHE_KEY, FREEZE_CACHE_S, PartnerFreezeService } from './partner-freeze';

function build(row: { freeze: string } | null = { freeze: 'money' }, redis = createFakeRedis()) {
  const tx = { partnerApiState: { findUnique: vi.fn(async () => row) } };
  const prisma = { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  return { service: new PartnerFreezeService(prisma as never, redis as never), tx, redis };
}

describe('la congelación de la API de socios', () => {
  it('sin copia en Redis, la fila; y la copia queda 60 s para las demás réplicas', async () => {
    const s = build();
    expect(await s.service.current()).toBe('money');
    expect(await s.redis.get(FREEZE_CACHE_KEY)).toBe('money');
    expect(await s.redis.ttl(FREEZE_CACHE_KEY)).toBeLessThanOrEqual(FREEZE_CACHE_S);
    expect(await s.service.current()).toBe('money');
    expect(s.tx.partnerApiState.findUnique).toHaveBeenCalledTimes(1);
  });

  it('una copia que no es un valor válido no cuenta: se lee la fila', async () => {
    const redis = createFakeRedis();
    await redis.set(FREEZE_CACHE_KEY, 'quizá');
    const s = build({ freeze: 'all' }, redis);
    expect(await s.service.current()).toBe('all');
  });

  it('sin fila (o con un valor raro), none', async () => {
    expect(await build(null).service.current()).toBe('none');
    expect(await build({ freeze: 'raro' }).service.current()).toBe('none');
  });

  it('Redis caído: falla (el guard lo convierte en 503), nunca «sin congelar» a ciegas', async () => {
    const redis = createFakeRedis();
    vi.spyOn(redis, 'get').mockRejectedValueOnce(new Error('Connection is closed.'));
    const s = build({ freeze: 'none' }, redis);
    await expect(s.service.current()).rejects.toThrow('Connection is closed.');
    expect(s.tx.partnerApiState.findUnique).not.toHaveBeenCalled();
  });
});
