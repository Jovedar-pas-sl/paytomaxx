import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { TreasuryModule } from '../treasury/treasury.module';
import { BankHoldsController } from './bank-holds.controller';
import { BankHoldsService } from './bank-holds.service';
import { OperatorsController } from './operators.controller';
import { OperatorsService } from './operators.service';
import { StaffQrController } from './staff-qr.controller';

@Module({
  imports: [AuditModule, AuthModule, TreasuryModule],
  controllers: [OperatorsController, StaffQrController, BankHoldsController],
  providers: [OperatorsService, BankHoldsService],
  exports: [OperatorsService, BankHoldsService],
})
export class OperatorsModule {}
