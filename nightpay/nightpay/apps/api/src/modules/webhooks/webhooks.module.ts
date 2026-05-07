import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WebhooksController } from './webhooks.controller';
import { WEBHOOKS_INGEST_QUEUE } from '../queues/queue-tokens';

@Module({
  imports: [BullModule.registerQueue({ name: WEBHOOKS_INGEST_QUEUE })],
  controllers: [WebhooksController],
})
export class WebhooksModule {}
