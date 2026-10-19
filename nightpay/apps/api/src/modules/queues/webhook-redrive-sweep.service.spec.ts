import { afterEach, describe, it, expect, vi } from 'vitest';
import { WebhookRedriveSweepService } from './webhook-redrive-sweep.service';

const NOW = new Date('2026-10-19T12:00:00Z');

function makeSweep(opts: { pending?: Array<{ id: bigint; provider: string; externalEventId: string }>; failedJob?: boolean; addFails?: string } = {}) {
  const prisma = { webhookDelivery: { findMany: vi.fn().mockResolvedValue(opts.pending ?? []) } };
  const job = { isFailed: vi.fn().mockResolvedValue(opts.failedJob ?? false), remove: vi.fn().mockResolvedValue(undefined) };
  const queue = {
    getJob: vi.fn().mockResolvedValue(opts.failedJob === undefined ? undefined : job),
    add: vi.fn().mockImplementation(async (_n: string, data: { deliveryId: string }) => {
      if (opts.addFails === data.deliveryId) throw new Error('redis caído');
    }),
  };
  return { svc: new WebhookRedriveSweepService(prisma as never, queue as never), prisma, queue, job };
}

describe('repaso de avisos sin procesar (P5)', () => {
  afterEach(() => vi.useRealTimers());

  it('busca los no procesados de las últimas 24 h, con 15 min de margen, los más viejos primero', async () => {
    const { svc, prisma } = makeSweep();
    await expect(svc.sweep(NOW)).resolves.toEqual({ redriven: 0, failed: 0 });
    expect(prisma.webhookDelivery.findMany).toHaveBeenCalledWith({
      where: {
        processedAt: null,
        createdAt: { lt: new Date('2026-10-19T11:45:00Z'), gt: new Date('2026-10-18T12:00:00Z') },
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: { id: true, provider: true, externalEventId: true },
    });
  });

  it('un aviso que agotó los reintentos: se quita el trabajo fallido y se vuelve a encolar con su id', async () => {
    const { svc, queue, job } = makeSweep({
      pending: [{ id: BigInt(9), provider: 'PAYTEF', externalEventId: 'pl-1_t-1' }],
      failedJob: true,
    });
    await expect(svc.sweep(NOW)).resolves.toEqual({ redriven: 1, failed: 0 });
    expect(queue.getJob).toHaveBeenCalledWith('webhook-PAYTEF-pl-1_t-1');
    expect(job.remove).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      'process-webhook',
      { deliveryId: '9' },
      { jobId: 'webhook-PAYTEF-pl-1_t-1', attempts: 5, backoff: { type: 'exponential', delay: 5000 } },
    );
  });

  it('si uno no se puede encolar, sigue con los demás', async () => {
    const { svc, queue } = makeSweep({
      pending: [
        { id: BigInt(1), provider: 'REDSYS', externalEventId: 'A-0000' },
        { id: BigInt(2), provider: 'REDSYS', externalEventId: 'B-0000' },
      ],
      addFails: '1',
    });
    await expect(svc.sweep(NOW)).resolves.toEqual({ redriven: 1, failed: 1 });
    expect(queue.add).toHaveBeenCalledTimes(2);
  });

  it('en pruebas no arranca el temporizador; fuera, sí (y se para al cerrar)', () => {
    const { svc } = makeSweep();
    svc.onModuleInit();
    expect((svc as unknown as { timer: unknown }).timer).toBeNull();

    vi.useFakeTimers();
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      svc.onModuleInit();
      expect((svc as unknown as { timer: unknown }).timer).not.toBeNull();
    } finally {
      process.env.NODE_ENV = prev;
      svc.onModuleDestroy();
    }
  });

  it('un fallo de la base en el repaso programado no tumba el proceso', async () => {
    const { svc, prisma } = makeSweep();
    prisma.webhookDelivery.findMany.mockRejectedValueOnce(new Error('db caída'));
    await expect((svc as unknown as { tick: () => Promise<void> }).tick()).resolves.toBeUndefined();
  });
});
