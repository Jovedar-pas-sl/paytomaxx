import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PaymentsModule } from '../payments/payments.module';
import { WalletsModule } from '../wallets/wallets.module';
import { DeviceGuard } from './device.guard';
import { PosDeviceSaldoController } from './pos-device-saldo.controller';
import { PosDeviceController } from './pos-device.controller';
import { PosDeviceService } from './pos-device.service';

/** Datáfono PAX con la app NightPay (Paytef Device API) y el cobro del saldo con PIN. */
@Module({
  imports: [AuthModule, PaymentsModule, WalletsModule],
  controllers: [PosDeviceController, PosDeviceSaldoController],
  providers: [PosDeviceService, DeviceGuard],
})
export class PosDeviceModule {}
