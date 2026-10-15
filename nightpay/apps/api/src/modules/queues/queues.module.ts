import { forwardRef, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { QrExpireProcessor } from './qr-expire.processor';
import { OrphanReconcileProcessor } from './orphan-reconcile.processor';
import { WebhookIngestProcessor } from './webhook-ingest.processor';
import { RetireReconcileDailyService } from './retire-reconcile-daily.service';
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
            // password incluye username `default` si esta presente; si REDIS_URL es
            // `redis://:pass@host`, url.password = pass y url.username = '' (correcto).
            password: url.password || undefined,
            username: url.username || undefined,
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
      // Solo para retirar la conciliación diaria antigua (ver RetireReconcileDailyService).
      { name: RECONCILIATION_QUEUE },
    ),
    forwardRef(() => PaymentsModule),
  ],
  providers: [
    QrExpireProcessor,
    OrphanReconcileProcessor,
    WebhookIngestProcessor,
    RetireReconcileDailyService,
  ],
  exports: [BullModule],
})
export class QueuesModule {}
