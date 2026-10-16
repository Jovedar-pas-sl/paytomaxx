import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  GOOGLE_WALLET_SYNC_SCHEDULER,
  GoogleWalletSyncProcessor,
  GoogleWalletSyncScheduler,
} from './google-wallet-sync.processor';

function makeQueue() {
  return {
    upsertJobScheduler: vi.fn().mockResolvedValue({}),
    removeJobScheduler: vi.fn().mockResolvedValue(true),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('programar el repaso de Google Wallet', () => {
  it('configurado → un trabajo repetido cada 2 min (uno para todas las réplicas)', async () => {
    const queue = makeQueue();
    const svc = new GoogleWalletSyncScheduler(queue as never, { enabled: true } as never);
    await expect(svc.schedule()).resolves.toBe('scheduled');
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      GOOGLE_WALLET_SYNC_SCHEDULER,
      { every: 120_000 },
      expect.objectContaining({ name: 'sync' }),
    );
    expect(queue.removeJobScheduler).not.toHaveBeenCalled();
  });

  it('sin configurar → no se programa nada (y se quita el de antes, si lo había)', async () => {
    const queue = makeQueue();
    const svc = new GoogleWalletSyncScheduler(queue as never, { enabled: false } as never);
    await expect(svc.schedule()).resolves.toBe('removed');
    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    expect(queue.removeJobScheduler).toHaveBeenCalledWith(GOOGLE_WALLET_SYNC_SCHEDULER);
  });

  it('si Redis falla no rompe el arranque', async () => {
    const queue = makeQueue();
    queue.upsertJobScheduler.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const svc = new GoogleWalletSyncScheduler(queue as never, { enabled: true } as never);
    await expect(svc.schedule()).resolves.toBe('failed');
  });

  it('en pruebas (NODE_ENV=test) no toca Redis al arrancar', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const queue = makeQueue();
    await new GoogleWalletSyncScheduler(queue as never, { enabled: true } as never).onModuleInit();
    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    expect(queue.removeJobScheduler).not.toHaveBeenCalled();
  });
});

describe('worker del repaso', () => {
  function withWorker(enabled: boolean) {
    const gwallet = { enabled, syncDue: vi.fn().mockResolvedValue({ checked: 1, updated: 1, revoked: 0, failed: 0 }) };
    const processor = new GoogleWalletSyncProcessor(gwallet as never);
    const worker = { run: vi.fn().mockResolvedValue(undefined) };
    (processor as unknown as { _worker: unknown })._worker = worker;
    return { processor, worker, gwallet };
  }

  it('cada trabajo pone al día los pases', async () => {
    const { processor, gwallet } = withWorker(true);
    await expect(processor.process({} as never)).resolves.toEqual({ checked: 1, updated: 1, revoked: 0, failed: 0 });
    expect(gwallet.syncDue).toHaveBeenCalled();
  });

  it('el worker solo arranca si Google Wallet está configurado', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const on = withWorker(true);
    on.processor.onApplicationBootstrap();
    expect(on.worker.run).toHaveBeenCalledTimes(1);
    const off = withWorker(false);
    off.processor.onApplicationBootstrap();
    expect(off.worker.run).not.toHaveBeenCalled();
  });

  it('apagado a mano (NIGHTPAY_DISABLE_GOOGLE_WALLET_SYNC=1) → no arranca', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NIGHTPAY_DISABLE_GOOGLE_WALLET_SYNC', '1');
    const on = withWorker(true);
    on.processor.onApplicationBootstrap();
    expect(on.worker.run).not.toHaveBeenCalled();
  });
});
