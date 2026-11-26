import { describe, it, expect, vi } from 'vitest';
import { RELEASE_LOCK_LUA } from '../../common/redis/release-lock';
import { InvalidTransitionError } from '../payments/payment.machine';
import type { LockedPaymentRow, TransitionOptions } from '../payments/payments.service';
import { QrExpireSweepService } from './qr-expire-sweep.service';

/**
 * Barrido de cobros caducados (DIN-8/DI-09): el trabajo qr-expire se encola
 * después de guardar el cobro; si Redis fallaba justo ahí (el reintento con la
 * misma Idempotency-Key devuelve el cobro sin volver a encolar) o el trabajo
 * agotaba sus reintentos, el cobro se quedaba CREATED para siempre.
 */

const NOW = new Date('2026-10-26T12:00:00Z');
const A = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';
const B = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const C = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8dabcd';

const LOCK = 'np:qr-expire-sweep:lock';

/** El Redis compartido por las réplicas: SET NX y el borrado condicional del candado (RELEASE_LOCK_LUA). */
function lockRedis(takenBy?: string) {
  const store = new Map<string, string>(takenBy ? [[LOCK, takenBy]] : []);
  return {
    store,
    set: vi.fn(async (key: string, value: string, ..._opts: Array<string | number>): Promise<'OK' | null> => {
      if (store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    eval: vi.fn(async (script: string, _keys: number, key: string, value: string): Promise<number> => {
      if (script !== RELEASE_LOCK_LUA) throw new Error('script inesperado');
      if (store.get(key) !== value) return 0;
      store.delete(key);
      return 1;
    }),
  };
}

function makeSweep(
  opts: {
    lockedBy?: string;
    redis?: ReturnType<typeof lockRedis>;
    due?: string[];
    status?: Record<string, string>;
    fail?: Record<string, Error>;
  } = {},
) {
  const tx = {
    payment: { findMany: vi.fn(async () => (opts.due ?? []).map((id) => ({ id }))) },
  };
  const prisma = { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const redis = opts.redis ?? lockRedis(opts.lockedBy);
  const payments = {
    requeueBankChecks: vi.fn(async () => ({ canceled: 0 })),
    transition: vi.fn(async (id: string, _event: unknown, _tenant: unknown, o?: TransitionOptions) => {
      const failure = opts.fail?.[id];
      if (failure) throw failure;
      await o?.prepare?.({} as never, { status: opts.status?.[id] ?? 'CREATED' } as LockedPaymentRow);
    }),
  };
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new QrExpireSweepService(prisma as never, payments as never, redis as never);
  Object.assign(service, { logger });
  return { service, tx, redis, payments, logger };
}

describe('QrExpireSweepService — cobros sin pagar pasado su plazo', () => {
  it('busca los CREATED/AWAITING_CAPTURE caducados hace más de 5 min (su trabajo ya tuvo su ocasión), los más viejos primero', async () => {
    const { service, tx } = makeSweep();
    await service.sweep(NOW);
    expect(tx.payment.findMany).toHaveBeenCalledWith({
      where: {
        status: { in: ['CREATED', 'AWAITING_CAPTURE'] },
        qrExpiresAt: { lt: new Date('2026-10-26T11:55:00Z') },
      },
      orderBy: { qrExpiresAt: 'asc' },
      take: 200,
      select: { id: true },
    });
  });

  it('cada uno pasa a EXPIRED con la misma transición que el trabajo (TIMEOUT, fila bloqueada)', async () => {
    const { service, payments } = makeSweep({ due: [A, B] });
    await expect(service.sweep(NOW)).resolves.toEqual({ expired: 2, skipped: 0, failed: 0 });
    expect(payments.transition.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([
      [A, { type: 'TIMEOUT' }, undefined],
      [B, { type: 'TIMEOUT' }, undefined],
    ]);
  });

  it('idempotente: uno que mientras tanto fue al banco o se pagó no se toca (lo decide la fila bloqueada)', async () => {
    const { service } = makeSweep({ due: [A, B], status: { [A]: 'AUTHORIZING' } });
    await expect(service.sweep(NOW)).resolves.toEqual({ expired: 1, skipped: 1, failed: 0 });
  });

  it('ya caducado por el trabajo o por la otra réplica (transición no válida): se salta sin error', async () => {
    const { service } = makeSweep({ due: [A], fail: { [A]: new InvalidTransitionError('EXPIRED', 'TIMEOUT') } });
    await expect(service.sweep(NOW)).resolves.toEqual({ expired: 0, skipped: 1, failed: 0 });
  });

  it('un error en uno no corta los demás: se cuenta y se registra', async () => {
    const { service, logger } = makeSweep({ due: [A, B, C], fail: { [B]: new Error('deadlock detected') } });
    await expect(service.sweep(NOW)).resolves.toEqual({ expired: 2, skipped: 0, failed: 1 });
    expect(String(logger.error.mock.calls[0]![0])).toContain('deadlock detected');
  });

  it('la base o Redis caídos en la vuelta: se registra y no tumba nada', async () => {
    const { service, redis, logger } = makeSweep();
    redis.set.mockRejectedValueOnce(new Error('ECONNREFUSED 6379'));
    await expect(service.tick(NOW)).resolves.toBeUndefined();
    expect(String(logger.error.mock.calls[0]![0])).toContain('ECONNREFUSED');
  });
});

describe('QrExpireSweepService — el candado entre réplicas (SET NX con un valor único; se suelta al terminar)', () => {
  it('tras arrancar, la vuelta de los 10 min barre: el barrido del arranque (a los 90 s) suelta su candado al terminar', async () => {
    // Prueba real: el del arranque lo dejaba puesto 540 s y la vuelta de los
    // 600 s (510 s después) lo encontraba: la primera caducidad, a los ~20 min.
    const { service, redis, tx } = makeSweep();
    await service.tick(NOW);
    expect(redis.store.has(LOCK)).toBe(false);
    await service.tick(new Date(NOW.getTime() + 510_000));
    expect(tx.payment.findMany).toHaveBeenCalledTimes(2);
    expect(redis.store.has(LOCK)).toBe(false);
  });

  it('cada vuelta pone un valor suyo (único), con caducidad por si la réplica se cae a mitad, y suelta solo ese', async () => {
    const { service, redis } = makeSweep();
    await service.tick(NOW);
    await service.tick(NOW);
    const [first, second] = redis.set.mock.calls.map((c) => c[1]);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
    expect(redis.set.mock.calls[0]).toEqual([LOCK, first, 'EX', 540, 'NX']);
    expect(redis.eval.mock.calls).toEqual([
      [RELEASE_LOCK_LUA, 1, LOCK, first],
      [RELEASE_LOCK_LUA, 1, LOCK, second],
    ]);
  });

  it('con dos réplicas (start-first) nunca barren a la vez: mientras una barre, la otra no; al terminar, ya puede', async () => {
    const redis = lockRedis();
    const one = makeSweep({ redis, due: [A] });
    const other = makeSweep({ redis, due: [A] });
    let finish!: () => void;
    one.tx.payment.findMany.mockImplementationOnce(
      () => new Promise<Array<{ id: string }>>((resolve) => (finish = () => resolve([{ id: A }]))),
    );
    const running = one.service.tick(NOW);
    await vi.waitFor(() => expect(one.tx.payment.findMany).toHaveBeenCalled());
    await other.service.tick(NOW);
    expect(other.tx.payment.findMany).not.toHaveBeenCalled();
    finish();
    await running;
    expect(one.payments.transition).toHaveBeenCalledTimes(1);
    await other.service.tick(NOW);
    expect(other.tx.payment.findMany).toHaveBeenCalledTimes(1);
  });

  it('otra réplica con el candado puesto: no se barre ni se le quita', async () => {
    const { service, redis, tx } = makeSweep({ lockedBy: 'la-otra' });
    await service.tick(NOW);
    expect(tx.payment.findMany).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
    expect(redis.store.get(LOCK)).toBe('la-otra');
  });

  it('si el suyo caducó a mitad de vuelta y lo tomó la otra réplica, al terminar no le quita el suyo', async () => {
    const { service, redis, tx } = makeSweep();
    tx.payment.findMany.mockImplementationOnce(async () => {
      redis.store.set(LOCK, 'la-otra');
      return [];
    });
    await service.tick(NOW);
    expect(redis.store.get(LOCK)).toBe('la-otra');
  });

  it('si la vuelta falla, el candado se suelta igual (no hay que esperar a que caduque)', async () => {
    const { service, redis, tx, logger } = makeSweep();
    tx.payment.findMany.mockRejectedValueOnce(new Error('connection terminated'));
    await expect(service.tick(NOW)).resolves.toBeUndefined();
    expect(String(logger.error.mock.calls[0]![0])).toContain('connection terminated');
    expect(redis.store.has(LOCK)).toBe(false);
  });

  it('en cada vuelta vuelve a preguntar al banco (cancelados recientes); si falla, se registra y no tumba nada', async () => {
    const { service, payments, logger } = makeSweep();
    await service.tick(NOW);
    expect(payments.requeueBankChecks).toHaveBeenCalledWith(NOW);
    payments.requeueBankChecks.mockRejectedValueOnce(new Error('redis caído'));
    await expect(service.tick(NOW)).resolves.toBeUndefined();
    expect(String(logger.error.mock.calls[0]![0])).toContain('redis caído');
  });

  it('Redis caído al soltarlo: se registra y no tumba nada (el candado caduca solo)', async () => {
    const { service, redis, logger } = makeSweep({ due: [A] });
    redis.eval.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(service.tick(NOW)).resolves.toBeUndefined();
    expect(String(logger.error.mock.calls[0]![0])).toContain('ECONNRESET');
  });
});
