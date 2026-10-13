import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PaymentsModule } from '../payments/payments.module';
import { DeviceGuard } from './device.guard';
import { PosDeviceController } from './pos-device.controller';
import { PosDeviceService } from './pos-device.service';

/** Datáfono PAX con la app NightPay (Paytef Device API). */
@Module({
  imports: [AuthModule, PaymentsModule],
  controllers: [PosDeviceController],
  providers: [PosDeviceService, DeviceGuard],
})
export class PosDeviceModule {}
