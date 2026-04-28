import { forwardRef, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { QrExpireProcessor } from './qr-expire.processor';
import { OrphanReconcileProcessor } from './orphan-reconcile.processor';
import { WebhookIngestProcessor } from './webhook-ingest.processor';
import { ReconcileDailyProcessor } from './reconcile-daily.processor';
import { ReconcileSchedulerService } from './reconcile-scheduler.service';
import {
  QR_EXPIRE_QUEUE,
  ORPHAN_RECONCILE_QUEUE,
  WEBHOOKS_INGEST_QUEUE,
  RECONCILIATION_QUEUE,
} from './queue-tokens';
import { PaymentsModule } from '../payments/payments.module';

/**
 * Setup global de BullMQ + procesadores.
 *
 * Conexion Redis se lee de REDIS_URL (formato redis://host:port[/db]).
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = new URL(config.getOrThrow<string>('REDIS_URL'));
        return {
          connection: {
            host: url.hostname,
            port: Number(url.port || 6379),
            db: url.pathname && url.pathname !== '/' ? Number(url.pathname.slice(1)) : 0,
          },
          defaultJobOptions: {
            removeOnComplete: { age: 3600 * 24, count: 1000 },
            removeOnFail: { age: 3600 * 24 * 7 },
          },
        };
      },
    }),
    BullModule.registerQueue(
      { name: QR_EXPIRE_QUEUE },
      { name: ORPHAN_RECONCILE_QUEUE },
      { name: WEBHOOKS_INGEST_QUEUE },
      { name: RECONCILIATION_QUEUE },
    ),
    forwardRef(() => PaymentsModule),
  ],
  providers: [
    QrExpireProcessor,
    OrphanReconcileProcessor,
    WebhookIngestProcessor,
    ReconcileDailyProcessor,
    ReconcileSchedulerService,
  ],
  exports: [BullModule],
})
export class QueuesModule {}
