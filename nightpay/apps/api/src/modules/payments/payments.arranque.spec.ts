import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PaymentsService } from './payments.service';

/**
 * Al arrancar la API: los cobros atascados en AUTHORIZING (de antes del
 * despliegue) vuelven a la cola de conciliación, una sola réplica a la vez.
 * Y el panel del camarero: cobros con datáfono pendientes de confirmar.
 */

const NOW = new Date('2026-10-17T01:30:00+02:00');
const TENANT = '5b0c8f7e-2d1a-4c3b-9e8f-0a1b2c3d4e5f';
const OTHER_TENANT = 'e4d3c2b1-a0f9-4e8d-8c7b-6a5f4e3d2c1b';
const STUCK_A = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';
const STUCK_B = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

interface Opts {
  /** Respuesta de Redis al SET NX (null = otra réplica tiene el candado). */
  lock?: 'OK' | null;
  stuck?: Array<{ id: string; tenantId: string }>;
  dbError?: Error;
  queueError?: Error;
  pending?: Array<Record<string, unknown>>;
  /** Ids de cobro cuyo trabajo de conciliación agotó los reintentos (fallido en BullMQ). */
  failedJobs?: string[];
}

function makeService(opts: Opts = {}) {
  const redis = { set: vi.fn(async () => (opts.lock === undefined ? 'OK' : opts.lock)) };
  const prisma = {
    $queryRawUnsafe: vi.fn(async () => {
      if (opts.dbError) throw opts.dbError;
      return opts.stuck ?? [];
    }),
    payment: { findMany: vi.fn(async () => opts.pending ?? []) },
    // listPendingPos busca la compañera del servicio (cobro por el encargado): aquí, ninguna.
    asSystem: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ $queryRaw: vi.fn(async () => []) })),
  };
  const removed: string[] = [];
  const orphanQueue = {
    getJob: vi.fn(async (jobId: string) =>
      opts.failedJobs?.some((id) => `orphan-${id}` === jobId)
        ? { isFailed: async () => true, remove: async () => void removed.push(jobId) }
        : undefined,
    ),
    add: vi.fn(async () => {
      if (opts.queueError) throw opts.queueError;
      return {};
    }),
  };
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new PaymentsService(
    prisma as never,
    { get: () => undefined } as never,
    {} as never,
    orphanQueue as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    redis as never,
  );
  Object.assign(service, { logger });
  return { service, prisma, redis, orphanQueue, logger, removed };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('onApplicationBootstrap — barrido de cobros atascados', () => {
  it('otra réplica tiene el candado → ni consulta ni encola', async () => {
    const { service, prisma, orphanQueue } = makeService({ lock: null });
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(orphanQueue.add).not.toHaveBeenCalled();
  });

  it('con el candado (5 min, NX): reencola cada cobro atascado con jobId determinista', async () => {
    const { service, prisma, redis, orphanQueue } = makeService({
      stuck: [
        { id: STUCK_A, tenantId: TENANT },
        { id: STUCK_B, tenantId: OTHER_TENANT },
      ],
    });
    await service.onApplicationBootstrap();

    expect(redis.set).toHaveBeenCalledWith('boot-sweep:lock', '1', 'EX', 300, 'NX');
    const [sql, cutoff] = prisma.$queryRawUnsafe.mock.calls[0] as unknown as [string, Date];
    expect(sql).toContain(`status = 'AUTHORIZING'`);
    expect(sql).toContain('"providerTxId" IS NOT NULL');
    expect(sql).toContain('LIMIT 100');
    // Bitcoin no: su factura la vigila el repaso de BTCPay (la conciliación lo dejaba «Sin confirmar»).
    expect(sql).toContain(`provider::text <> 'BTCPAY'`);
    // Solo los de hace 2 min o más (los recientes los vigila su propio job).
    expect(cutoff).toEqual(new Date('2026-10-17T01:28:00+02:00'));

    const jobOptions = { delay: 5_000, attempts: 5, backoff: { type: 'exponential', delay: 30_000 } };
    expect(orphanQueue.add.mock.calls).toEqual([
      [
        'orphan-reconcile',
        { paymentId: STUCK_A, tenantId: TENANT },
        expect.objectContaining({ jobId: `orphan-${STUCK_A}`, ...jobOptions }),
      ],
      [
        'orphan-reconcile',
        { paymentId: STUCK_B, tenantId: OTHER_TENANT },
        expect.objectContaining({ jobId: `orphan-${STUCK_B}`, ...jobOptions }),
      ],
    ]);
  });

  it('un cobro cuyo trabajo agotó los reintentos (base caída) vuelve a la cola: se quita el fallido antes', async () => {
    const { service, orphanQueue, removed } = makeService({
      stuck: [
        { id: STUCK_A, tenantId: TENANT },
        { id: STUCK_B, tenantId: OTHER_TENANT },
      ],
      failedJobs: [STUCK_A],
    });
    await service.onApplicationBootstrap();
    expect(removed).toEqual([`orphan-${STUCK_A}`]);
    expect(orphanQueue.add.mock.calls.map((c) => (c as unknown as [string, unknown, { jobId: string }])[2].jobId)).toEqual([
      `orphan-${STUCK_A}`,
      `orphan-${STUCK_B}`,
    ]);
  });

  it('sin cobros atascados → no encola nada', async () => {
    const { service, orphanQueue } = makeService({ stuck: [] });
    await service.onApplicationBootstrap();
    expect(orphanQueue.add).not.toHaveBeenCalled();
  });

  it('la base falla → se registra como ERROR (no warn) y el arranque sigue', async () => {
    const { service, logger, orphanQueue } = makeService({ dbError: new Error('connection refused 10.0.0.5:5432') });
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(String(logger.error.mock.calls[0]![0])).toContain('connection refused');
    expect(logger.warn).not.toHaveBeenCalled();
    expect(orphanQueue.add).not.toHaveBeenCalled();
  });

  it('la cola falla → ERROR en el registro, sin tumbar el arranque', async () => {
    const { service, logger } = makeService({
      stuck: [{ id: STUCK_A, tenantId: TENANT }],
      queueError: new Error('READONLY You can\'t write against a read only replica'),
    });
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(String(logger.error.mock.calls[0]![0])).toContain('READONLY');
  });
});

describe('listPendingPos — panel del camarero', () => {
  const at = (iso: string) => new Date(iso);

  it('solo los cobros con datáfono pendientes de ESTE local, los más nuevos primero, máx. 50', async () => {
    const { service, prisma } = makeService();
    await service.listPendingPos(TENANT);
    await service.listPendingPos(TENANT, 'VIP');
    const [all, vip] = prisma.payment.findMany.mock.calls.map((c) => (c as unknown as [Record<string, unknown>])[0]);
    expect(all).toMatchObject({
      where: { tenantId: TENANT, status: 'CREATED', captureMethod: 'POS_EXTERNAL' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    expect(all!.where).not.toHaveProperty('terminal');
    expect(vip!.where).toEqual({
      tenantId: TENANT,
      status: 'CREATED',
      captureMethod: 'POS_EXTERNAL',
      terminal: { zone: 'VIP' },
    });
  });

  it('vista: quién lo creó (nombre, si no email, si no «—»), zona, datáfono y código corto', async () => {
    const row = (o: Record<string, unknown>) => ({
      amountCents: 4_500,
      serviceFeeCents: 0,
      currency: 'EUR',
      createdAt: at('2026-10-17T01:25:00+02:00'),
      qrExpiresAt: at('2026-10-17T01:55:00+02:00'),
      qrToken: 'qr-pos-1',
      createdBy: null,
      terminal: null,
      ...o,
    });
    const { service } = makeService({
      pending: [
        row({
          id: '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b',
          createdBy: { displayName: 'Lucía', email: 'lucia@salabambu.es' },
          terminal: { zone: 'BARRA', label: 'Barra 1' },
        }),
        row({ id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', createdBy: { displayName: null, email: 'nerea@salabambu.es' } }),
        row({ id: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8dabcd' }),
      ],
    });
    const out = await service.listPendingPos(TENANT);
    expect(out[0]).toEqual({
      id: '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b',
      // Lo que se cobra en el datáfono (con la comisión del servicio, aquí 0).
      amountCents: 4_500,
      baseAmountCents: 4_500,
      serviceFeeCents: 0,
      currency: 'EUR',
      createdAt: '2026-10-16T23:25:00.000Z',
      qrExpiresAt: '2026-10-16T23:55:00.000Z',
      createdByName: 'Lucía',
      zone: 'BARRA',
      terminalLabel: 'Barra 1',
      qrToken: 'qr-pos-1',
      // Los 6 últimos del id, para decirlo en voz alta.
      refCode: '4F5A6B',
    });
    expect(out.map((p) => [p.createdByName, p.zone, p.terminalLabel, p.refCode])).toEqual([
      ['Lucía', 'BARRA', 'Barra 1', '4F5A6B'],
      ['nerea@salabambu.es', null, null, '3B4C5D'],
      ['—', null, null, '8DABCD'],
    ]);
  });
});
