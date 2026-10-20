import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { TreasuryModule } from '../treasury/treasury.module';
import { OperatorsController } from './operators.controller';
import { OperatorsService } from './operators.service';
import { StaffQrController } from './staff-qr.controller';

@Module({
  imports: [AuditModule, AuthModule, TreasuryModule],
  controllers: [OperatorsController, StaffQrController],
  providers: [OperatorsService],
  exports: [OperatorsService],
})
export class OperatorsModule {}
