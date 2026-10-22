import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { MetricsService } from '../metrics/metrics.service';
import { QR_EXPIRE_QUEUE, ORPHAN_RECONCILE_QUEUE, WEBHOOKS_INGEST_QUEUE, RECONCILIATION_QUEUE, GOOGLE_WALLET_SYNC_QUEUE } from './queue-tokens';

@Injectable()
export class QueueMetricsService implements OnModuleInit, OnModuleDestroy {
  private unregister?: () => void;

  constructor(
    @Inject(MetricsService) private readonly metrics: MetricsService,
    @InjectQueue(QR_EXPIRE_QUEUE) private readonly qr: Queue,
    @InjectQueue(ORPHAN_RECONCILE_QUEUE) private readonly reconcile: Queue,
    @InjectQueue(WEBHOOKS_INGEST_QUEUE) private readonly webhooks: Queue,
    @InjectQueue(RECONCILIATION_QUEUE) private readonly retired: Queue,
    @InjectQueue(GOOGLE_WALLET_SYNC_QUEUE) private readonly wallet: Queue,
  ) {}

  onModuleInit(): void {
    this.unregister = this.metrics.observeQueues([this.qr, this.reconcile, this.webhooks, this.retired, this.wallet]);
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }
}
