import { describe, it, expect, vi } from 'vitest';
import { LEGACY_RECONCILE_JOB, RetireReconcileDailyService } from './retire-reconcile-daily.service';

function makeQueue(repeatables: Array<{ name: string; key: string }>) {
  return {
    getRepeatableJobs: vi.fn().mockResolvedValue(repeatables),
    removeRepeatableByKey: vi.fn().mockResolvedValue(true),
    drain: vi.fn().mockResolvedValue(undefined),
  };
}

describe('RetireReconcileDailyService (#52)', () => {
  it('quita de Redis los trabajos repetidos de la conciliación diaria y vacía lo programado', async () => {
    const queue = makeQueue([
      { name: LEGACY_RECONCILE_JOB, key: 'reconcile-daily:reconcile-venue-1:::0 7 * * *' },
      { name: LEGACY_RECONCILE_JOB, key: 'reconcile-daily:reconcile-venue-2:::0 7 * * *' },
      { name: 'otro-trabajo', key: 'otro' },
    ]);
    const svc = new RetireReconcileDailyService(queue as never);
    expect(await svc.retire()).toBe(2);
    expect(queue.removeRepeatableByKey.mock.calls.map((c) => c[0])).toEqual([
      'reconcile-daily:reconcile-venue-1:::0 7 * * *',
      'reconcile-daily:reconcile-venue-2:::0 7 * * *',
    ]);
    expect(queue.drain).toHaveBeenCalledWith(true);
  });

  it('ya retirada → no quita nada (y sigue vaciando por si acaso)', async () => {
    const queue = makeQueue([]);
    expect(await new RetireReconcileDailyService(queue as never).retire()).toBe(0);
    expect(queue.removeRepeatableByKey).not.toHaveBeenCalled();
  });

  it('si Redis falla no rompe el arranque', async () => {
    const queue = makeQueue([]);
    queue.getRepeatableJobs.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const svc = new RetireReconcileDailyService(queue as never);
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
  });
});
