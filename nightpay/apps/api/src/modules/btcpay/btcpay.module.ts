import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuthModule } from '../auth/auth.module';
import { PaymentsModule } from '../payments/payments.module';
import { WEBHOOKS_INGEST_QUEUE } from '../queues/queue-tokens';
import { BtcpayClients } from './btcpay-client';
import { BtcpayInvoiceService } from './btcpay-invoice.service';
import { BtcpayNet, SafeBtcpayNet } from './btcpay-net';
import { BtcpayPayController } from './btcpay-pay.controller';
import { BtcpaySettingsController } from './btcpay-settings.controller';
import { BtcpayStaffController } from './btcpay-staff.controller';
import { BtcpayStoreService } from './btcpay-store.service';
import { BtcpaySweepService } from './btcpay-sweep.service';
import { BtcpayWebhookController } from './btcpay-webhook.controller';

/**
 * «Pagar con bitcoin» (BTCPay Server). Con BTCPAY_ENABLED apagado (por defecto)
 * el módulo existe pero ninguna ruta responde (404), no hay tarea de respaldo y
 * la página de pago no enseña el botón. Cada local, además, lo activa en Ajustes.
 */
@Module({
  imports: [BullModule.registerQueue({ name: WEBHOOKS_INGEST_QUEUE }), AuthModule, PaymentsModule],
  controllers: [BtcpaySettingsController, BtcpayStaffController, BtcpayPayController, BtcpayWebhookController],
  providers: [
    { provide: BtcpayNet, useFactory: () => new SafeBtcpayNet() },
    { provide: BtcpayClients, useFactory: (net: BtcpayNet) => new BtcpayClients(net), inject: [BtcpayNet] },
    BtcpayStoreService,
    BtcpayInvoiceService,
    BtcpaySweepService,
  ],
  exports: [BtcpayInvoiceService, BtcpayStoreService],
})
export class BtcpayModule {}
