import { describe, it, expect, vi } from 'vitest';
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

function makeSweep(opts: { lock?: 'OK' | null; due?: string[]; status?: Record<string, string>; fail?: Record<string, Error> } = {}) {
  const tx = {
    payment: { findMany: vi.fn(async () => (opts.due ?? []).map((id) => ({ id }))) },
  };
  const prisma = { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const redis = { set: vi.fn(async () => (opts.lock === undefined ? 'OK' : opts.lock)) };
  const payments = {
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

  it('con dos réplicas (start-first) solo barre una: candado SET NX con caducidad menor que el intervalo', async () => {
    const free = makeSweep({ due: [A] });
    await free.service.tick(NOW);
    expect(free.redis.set).toHaveBeenCalledWith('np:qr-expire-sweep:lock', '1', 'EX', 540, 'NX');
    expect(free.payments.transition).toHaveBeenCalledTimes(1);

    const taken = makeSweep({ lock: null, due: [A] });
    await taken.service.tick(NOW);
    expect(taken.payments.transition).not.toHaveBeenCalled();
  });

  it('la base o Redis caídos en la vuelta: se registra y no tumba nada', async () => {
    const { service, redis, logger } = makeSweep();
    redis.set.mockRejectedValueOnce(new Error('ECONNREFUSED 6379'));
    await expect(service.tick(NOW)).resolves.toBeUndefined();
    expect(String(logger.error.mock.calls[0]![0])).toContain('ECONNREFUSED');
  });
});
