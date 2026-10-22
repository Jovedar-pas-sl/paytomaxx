import 'reflect-metadata';
import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { MetricsService } from '../metrics/metrics.service';
import { QueueMetricsService } from './queue-metrics.service';
import { QR_EXPIRE_QUEUE, ORPHAN_RECONCILE_QUEUE, WEBHOOKS_INGEST_QUEUE, RECONCILIATION_QUEUE, GOOGLE_WALLET_SYNC_QUEUE } from './queue-tokens';

describe('QueueMetricsService wiring', () => {
  it('registers all five existing queues and removes them before BullMQ shutdown', async () => {
    const metrics = new MetricsService();
    const queues = [QR_EXPIRE_QUEUE, ORPHAN_RECONCILE_QUEUE, WEBHOOKS_INGEST_QUEUE, RECONCILIATION_QUEUE, GOOGLE_WALLET_SYNC_QUEUE]
      .map((name) => ({ name, getJobCounts: vi.fn().mockResolvedValue({ waiting: 1 }), getJobs: vi.fn().mockResolvedValue([]) } as unknown as Queue));
    const service = new QueueMetricsService(metrics, queues[0]!, queues[1]!, queues[2]!, queues[3]!, queues[4]!);
    service.onModuleInit();
    const text = await metrics.render();
    queues.forEach((queue) => expect(text).toContain(`nightpay_queue_depth{queue="${queue.name}"} 1`));
    service.onModuleDestroy();
    expect(await metrics.render()).not.toMatch(/nightpay_queue_depth\{queue=/);
    queues.forEach((queue) => expect(queue.getJobCounts).toHaveBeenCalledTimes(1));
  });
});
