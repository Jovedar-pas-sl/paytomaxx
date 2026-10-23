import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BrandFontController } from './brand-font.controller';
import { PaymentsController } from './payments.controller';
import { PublicPayController } from './public-pay.controller';
import { PaytefDebugController } from './paytef-debug.controller';
import { RedsysDebugController } from './redsys-debug.controller';
import { PeanpeDebugController } from './peanpe-debug.controller';
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
  controllers: [
    PaymentsController,
    PublicPayController,
    PaytefDebugController,
    RedsysDebugController,
    PeanpeDebugController,
    // La letra de la marca para las páginas del cliente (/pay/assets/manrope.woff2).
    BrandFontController,
  ],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
