import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WebhooksController } from './webhooks.controller';
import { WebhookProviderGate } from './webhook-provider-gate';
import { WEBHOOKS_INGEST_QUEUE } from '../queues/queue-tokens';

@Module({
  imports: [BullModule.registerQueue({ name: WEBHOOKS_INGEST_QUEUE })],
  controllers: [WebhooksController],
  providers: [WebhookProviderGate],
})
export class WebhooksModule {}
