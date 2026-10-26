import { describe, it, expect, vi } from 'vitest';
import { enqueueOrphanReconcile, ORPHAN_RECONCILE_JOB_OPTIONS } from './orphan-enqueue';

/**
 * La conciliación de un cobro sin aviso del banco va con un id de trabajo fijo
 * por cobro. Si uno agotó los reintentos (base o Redis caídos unos minutos),
 * BullMQ lo guarda como fallido con ese id y descarta cualquier add() con el
 * mismo: ni el barrido del arranque volvía a conciliar el cobro.
 */

const PAYMENT = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';
const TENANT = '5b0c8f7e-2d1a-4c3b-9e8f-0a1b2c3d4e5f';

function makeQueue(previous?: { failed: boolean; removeError?: Error }) {
  const job = previous
    ? {
        isFailed: vi.fn(async () => previous.failed),
        remove: vi.fn(async () => {
          if (previous.removeError) throw previous.removeError;
        }),
      }
    : null;
  const calls: string[] = [];
  const queue = {
    getJob: vi.fn(async () => job ?? undefined),
    add: vi.fn(async () => {
      calls.push('add');
      return {};
    }),
  };
  if (job) {
    job.remove.mockImplementation(async () => {
      calls.push('remove');
      if (previous?.removeError) throw previous.removeError;
    });
  }
  const logger = { warn: vi.fn(), log: vi.fn(), error: vi.fn() };
  return { queue, job, logger, calls };
}

describe('enqueueOrphanReconcile', () => {
  it('sin trabajo anterior: encola con el id del cobro, 5 reintentos y el retraso pedido', async () => {
    const { queue, logger } = makeQueue();
    await enqueueOrphanReconcile(queue as never, logger as never, { paymentId: PAYMENT, tenantId: TENANT }, 120_000);
    expect(queue.getJob).toHaveBeenCalledWith(`orphan-${PAYMENT}`);
    expect(queue.add).toHaveBeenCalledWith(
      'orphan-reconcile',
      { paymentId: PAYMENT, tenantId: TENANT },
      { jobId: `orphan-${PAYMENT}`, delay: 120_000, ...ORPHAN_RECONCILE_JOB_OPTIONS },
    );
    expect(ORPHAN_RECONCILE_JOB_OPTIONS).toEqual({
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: true,
      removeOnFail: 100,
    });
  });

  it('el anterior agotó los reintentos: se quita ANTES de encolar (si no, add() no haría nada)', async () => {
    const { queue, job, logger, calls } = makeQueue({ failed: true });
    await enqueueOrphanReconcile(queue as never, logger as never, { paymentId: PAYMENT, tenantId: TENANT }, 5_000);
    expect(job!.remove).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['remove', 'add']);
    expect(String(logger.warn.mock.calls[0]![0])).toContain(`orphan-${PAYMENT}`);
  });

  it('uno en cola o en curso no se toca: add() con el mismo id lo deja como está', async () => {
    const { queue, job, logger } = makeQueue({ failed: false });
    await enqueueOrphanReconcile(queue as never, logger as never, { paymentId: PAYMENT, tenantId: TENANT }, 5_000);
    expect(job!.remove).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('otra réplica lo quitó a la vez: se avisa y se encola igual', async () => {
    const { queue, logger } = makeQueue({ failed: true, removeError: new Error('Missing key for job') });
    await expect(
      enqueueOrphanReconcile(queue as never, logger as never, { paymentId: PAYMENT, tenantId: TENANT }, 5_000),
    ).resolves.toBeUndefined();
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Missing key for job'));
  });
});
