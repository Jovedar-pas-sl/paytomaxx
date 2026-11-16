import { afterEach, describe, it, expect, vi } from 'vitest';
import { GRACE_MS, SWEEP_EVERY_MS, WebhookRedriveSweepService } from './webhook-redrive-sweep.service';
import { WEBHOOK_JOB_RETRY } from './webhook-enqueue';

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

  it('busca los no procesados de las últimas 24 h, con 2 min de margen, los más viejos primero', async () => {
    const { svc, prisma } = makeSweep();
    await expect(svc.sweep(NOW)).resolves.toEqual({ redriven: 0, failed: 0 });
    expect(prisma.webhookDelivery.findMany).toHaveBeenCalledWith({
      where: {
        processedAt: null,
        createdAt: { lt: new Date('2026-10-19T11:58:00Z'), gt: new Date('2026-10-18T12:00:00Z') },
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
      { jobId: 'webhook-PAYTEF-pl-1_t-1', attempts: 8, backoff: { type: 'exponential', delay: 1000 } },
    );
  });

  it('un aviso que aún está en sus reintentos: su trabajo no se quita ni se cuenta (mismo id: add() no hace nada)', async () => {
    const { svc, queue, job } = makeSweep({
      pending: [{ id: BigInt(9), provider: 'REDSYS', externalEventId: '1234abcd-0000' }],
      failedJob: false,
    });
    const warn = vi.spyOn((svc as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn');
    await expect(svc.sweep(NOW)).resolves.toEqual({ redriven: 0, failed: 0 });
    expect(job.remove).not.toHaveBeenCalled();
    // Mismo id de trabajo que el que sigue vivo: BullMQ no crea otro.
    expect(queue.add).toHaveBeenCalledWith('process-webhook', { deliveryId: '9' }, expect.objectContaining({ jobId: 'webhook-REDSYS-1234abcd-0000' }));
    expect(warn).not.toHaveBeenCalled();
  });

  it('cada minuto; los reintentos de un aviso (8, desde 1 s, doblando) acaban en unos 2 min', () => {
    expect(SWEEP_EVERY_MS).toBe(60_000);
    expect(GRACE_MS).toBe(120_000);
    const { attempts, backoff } = WEBHOOK_JOB_RETRY;
    expect(attempts).toBe(8);
    expect(backoff).toEqual({ type: 'exponential', delay: 1_000 });
    // BullMQ: espera n = delay · 2^(n-1). 1 + 2 + … + 64 s = 127 s.
    const total = Array.from({ length: attempts - 1 }, (_, n) => backoff.delay * 2 ** n).reduce((a, b) => a + b, 0);
    expect(total).toBe(127_000);
    expect(total).toBeLessThan(150_000);
  });

  it('un repaso lento no se solapa con el siguiente', async () => {
    const { svc, prisma } = makeSweep();
    let release: (v: never[]) => void = () => undefined;
    prisma.webhookDelivery.findMany.mockReturnValueOnce(new Promise((r) => (release = r)));
    const tick = (svc as unknown as { tick: () => Promise<void> }).tick.bind(svc);
    const first = tick();
    await tick();
    expect(prisma.webhookDelivery.findMany).toHaveBeenCalledTimes(1);
    release([]);
    await first;
    await tick();
    expect(prisma.webhookDelivery.findMany).toHaveBeenCalledTimes(2);
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
