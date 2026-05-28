import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OperatorsModule } from '../operators/operators.module';
import { PaymentsModule } from '../payments/payments.module';
import { AdminController } from './admin.controller';

@Module({
  imports: [AuthModule, OperatorsModule, PaymentsModule],
  controllers: [AdminController],
})
export class AdminModule {}
