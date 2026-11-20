import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { TreasuryModule } from '../treasury/treasury.module';
import { BankHoldsController } from './bank-holds.controller';
import { BankHoldsService } from './bank-holds.service';
import { OperatorsController } from './operators.controller';
import { OperatorsService } from './operators.service';
import { PayoutAccountBackfill } from './payout-account-backfill';
import { StaffPushService } from './staff-push.service';
import { StaffQrController } from './staff-qr.controller';

@Module({
  imports: [AuditModule, AuthModule, TreasuryModule],
  controllers: [OperatorsController, StaffQrController, BankHoldsController],
  // PayoutAccountBackfill: al arrancar, cifra las cuentas de cobro que quedaran en claro.
  // StaffPushService: «Te han pagado» al móvil de la persona al apuntarle un pago.
  providers: [OperatorsService, BankHoldsService, PayoutAccountBackfill, StaffPushService],
  exports: [OperatorsService, BankHoldsService],
})
export class OperatorsModule {}
