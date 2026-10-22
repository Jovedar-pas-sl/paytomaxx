import { describe, it, expect, vi } from 'vitest';
import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  it('a promoted delayed job keeps its creation age without pretending to measure time since promotion', async () => {
    const metrics = new MetricsService();
    const queue = { name: 'promoted', getJobCounts: vi.fn().mockResolvedValue({ waiting: 1 }), getJobs: vi.fn().mockResolvedValue([{ timestamp: Date.now() - 300_000, delay: 0 }]) };
    metrics.observeQueues([queue]);
    const text = await metrics.render();
    expect(text).toMatch(/nightpay_queue_oldest_age_seconds\{queue="promoted"\} 300(?:\.\d+)?/);
    expect(queue.getJobs).toHaveBeenCalledWith(['waiting', 'active', 'prioritized', 'paused'], 0, 499);
  });

  it('future delayed retries with old creation timestamps count in depth but not ready-job age', async () => {
    const metrics = new MetricsService();
    const now = Date.now();
    const queue = {
      name: 'retry', getJobCounts: vi.fn().mockResolvedValue({ waiting: 1, delayed: 1 }),
      getJobs: vi.fn(async (states: string[]) => states.includes('delayed')
        ? [{ timestamp: now - 3_600_000, delay: 60_000 }, { timestamp: now - 30_000, delay: 0 }]
        : [{ timestamp: now - 30_000, delay: 0 }]),
    };
    metrics.observeQueues([queue]);
    const text = await metrics.render();
    expect(text).toContain('nightpay_queue_depth{queue="retry"} 2');
    expect(text).toMatch(/nightpay_queue_oldest_age_seconds\{queue="retry"\} 30(?:\.\d+)?/);
  });
  it('exports full earning reversal backlog and oldest age, and marks query failures unavailable', async () => {
    const metrics = new MetricsService();
    const query = vi.fn().mockResolvedValue({ pending: 101, oldestAgeSeconds: 10800 });
    metrics.observeEarningReversals(query);
    const text = await metrics.render();
    expect(text).toContain('nightpay_earning_reversal_pending 101');
    expect(text).toContain('nightpay_earning_reversal_oldest_age_seconds 10800');
    query.mockRejectedValueOnce(new Error('db unavailable'));
    const failed = await metrics.render();
    expect(failed).toContain('nightpay_earning_reversal_metrics_up 0');
    expect(failed).not.toMatch(/^nightpay_earning_reversal_pending /m);
  });
  it('exports real BullMQ states, unfinished depth and age, excluding completed/failed from depth', async () => {
    const metrics = new MetricsService();
    const now = Date.now();
    const queue = {
      name: 'webhooks-ingest',
      getJobCounts: vi.fn().mockResolvedValue({ waiting: 2, active: 1, delayed: 3, prioritized: 1, paused: 2, 'waiting-children': 0, failed: 7, completed: 20 }),
      getJobs: vi.fn(async (states: string[]) => states.includes('delayed')
        ? [{ timestamp: now - 120_000, delay: 0 }, { timestamp: now - 600_000, delay: 660_000 }]
        : [{ timestamp: now - 120_000, delay: 0 }]),
    };
    metrics.observeQueues([queue]);
    const text = await metrics.render();
    expect(text).toContain('nightpay_queue_depth{queue="webhooks-ingest"} 9');
    expect(text).toContain('nightpay_queue_jobs{queue="webhooks-ingest",state="failed"} 7');
    expect(text).toMatch(/nightpay_queue_oldest_age_seconds\{queue="webhooks-ingest"\} 120(?:\.\d+)?/);
    expect(text).toContain('nightpay_queue_metrics_up{queue="webhooks-ingest"} 1');
    expect(queue.getJobCounts).toHaveBeenCalledWith('waiting', 'active', 'delayed', 'prioritized', 'waiting-children', 'paused', 'failed', 'completed');
  });

  it('clears stale samples after Redis errors and recovers on the next scrape', async () => {
    const metrics = new MetricsService();
    const queue = {
      name: 'payments-lifecycle',
      getJobCounts: vi.fn().mockResolvedValue({ waiting: 5 }),
      getJobs: vi.fn().mockResolvedValue([]),
    };
    metrics.observeQueues([queue]);
    expect(await metrics.render()).toContain('nightpay_queue_depth{queue="payments-lifecycle"} 5');
    queue.getJobCounts.mockRejectedValueOnce(new Error('Redis disconnected'));
    const unavailable = await metrics.render();
    expect(unavailable).toContain('nightpay_queue_metrics_up{queue="payments-lifecycle"} 0');
    expect(unavailable).not.toContain('nightpay_queue_depth{queue="payments-lifecycle"}');
    expect(await metrics.render()).toContain('nightpay_queue_metrics_up{queue="payments-lifecycle"} 1');
  });

  it('scans large queues in bounded pages and includes older jobs beyond the first page', async () => {
    const metrics = new MetricsService();
    const now = Date.now();
    const queue = {
      name: 'large',
      getJobCounts: vi.fn().mockResolvedValue({ waiting: 501 }),
      getJobs: vi.fn()
        .mockResolvedValueOnce(Array.from({ length: 500 }, () => ({ timestamp: now })))
        .mockResolvedValueOnce([{ timestamp: now - 300_000 }]),
    };
    metrics.observeQueues([queue]);
    expect(await metrics.render()).toMatch(/nightpay_queue_oldest_age_seconds\{queue="large"\} 300(?:\.\d+)?/);
    expect(queue.getJobs).toHaveBeenNthCalledWith(1, expect.any(Array), 0, 499);
    expect(queue.getJobs).toHaveBeenNthCalledWith(2, expect.any(Array), 500, 999);
  });

  it('ignores jobs removed by a worker between listing IDs and reading job data', async () => {
    const metrics = new MetricsService();
    metrics.observeQueues([{
      name: 'race',
      getJobCounts: vi.fn().mockResolvedValue({ active: 0 }),
      getJobs: vi.fn().mockResolvedValue([undefined]),
    }]);
    const text = await metrics.render();
    expect(text).toContain('nightpay_queue_metrics_up{queue="race"} 1');
    expect(text).toContain('nightpay_queue_oldest_age_seconds{queue="race"} 0');
  });

  it('unregisters sources during shutdown without closing BullMQ-owned connections', async () => {
    const metrics = new MetricsService();
    let resolve!: (counts: Record<string, number>) => void;
    const queue = {
      name: 'test',
      getJobCounts: vi.fn().mockReturnValue(new Promise((r) => { resolve = r; })),
      getJobs: vi.fn().mockResolvedValue([]),
      close: vi.fn(),
    };
    const unregister = metrics.observeQueues([queue]);
    const pending = metrics.render();
    unregister();
    resolve({ waiting: 9 });
    expect(await pending).not.toContain('nightpay_queue_depth{queue="test"}');
    await metrics.render();
    expect(queue.getJobCounts).toHaveBeenCalledTimes(1);
    expect(queue.close).not.toHaveBeenCalled();
  });

  it('earningReversalFailed solo por local: el id del cobro no es etiqueta (cardinalidad sin límite)', async () => {
    const metrics = new MetricsService();
    // Quien aún pase payment_id no rompe (antes era etiqueta).
    metrics.earningReversalFailed.inc({ venue: 'v-1', payment_id: '7d0f4f9e-0000-4000-8000-000000000001' });
    metrics.earningReversalFailed.inc({ venue: 'v-1' });
    const text = await metrics.render();
    expect(text).toContain('nightpay_earning_reversal_failed_total{venue="v-1"} 2');
    expect(text).not.toContain('payment_id');
  });
});
