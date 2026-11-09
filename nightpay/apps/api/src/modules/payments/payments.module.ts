import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BrandFontController } from './brand-font.controller';
import { PaymentsController } from './payments.controller';
import { PublicPayController } from './public-pay.controller';
import { PaytefDebugController } from './paytef-debug.controller';
import { RedsysDebugController } from './redsys-debug.controller';
import { PeanpeDebugController } from './peanpe-debug.controller';
import { DeviceIpRetentionService } from './device-ip-retention.service';
import { PaymentsService } from './payments.service';
import { PayStatusService } from './pay-status.service';
import { QR_EXPIRE_QUEUE, ORPHAN_RECONCILE_QUEUE } from '../queues/queue-tokens';
import { WalletsModule } from '../wallets/wallets.module';
import { WebhooksModule } from '../webhooks/webhooks.module';

@Module({
  imports: [
    BullModule.registerQueue(
      { name: QR_EXPIRE_QUEUE },
      { name: ORPHAN_RECONCILE_QUEUE },
    ),
    WebhooksModule,
    WalletsModule, // Phase 1B — top-up flow credit on AUTHORIZED
  ],
  controllers: [
    PaymentsController,
    PublicPayController,
    PaytefDebugController,
    RedsysDebugController,
    PeanpeDebugController,
    // Las letras de la marca para las páginas del cliente (/pay/assets/instrument-sans.woff2 y manrope.woff2).
    BrandFontController,
  ],
  providers: [
    // La IP de los dispositivos de los cobros se borra a los 90 días (la lanza QrExpireSweepService).
    DeviceIpRetentionService,
    PaymentsService,
    PayStatusService,
  ],
  exports: [DeviceIpRetentionService, PaymentsService],
})
export class PaymentsModule {}
