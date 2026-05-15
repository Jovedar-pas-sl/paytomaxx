import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PaymentsController } from './payments.controller';
import { PublicPayController } from './public-pay.controller';
import { PaytefDebugController } from './paytef-debug.controller';
import { PaymentsService } from './payments.service';
import { QR_EXPIRE_QUEUE, ORPHAN_RECONCILE_QUEUE } from '../queues/queue-tokens';
import { WalletsModule } from '../wallets/wallets.module';

@Module({
  imports: [
    BullModule.registerQueue(
      { name: QR_EXPIRE_QUEUE },
      { name: ORPHAN_RECONCILE_QUEUE },
    ),
    WalletsModule, // Phase 1B — top-up flow credit on AUTHORIZED
  ],
  controllers: [PaymentsController, PublicPayController, PaytefDebugController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
