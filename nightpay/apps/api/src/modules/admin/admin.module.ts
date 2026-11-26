import { Module } from '@nestjs/common';
import { ApprovalsCoreModule } from '../approvals/approvals-core.module';
import { AuthModule } from '../auth/auth.module';
import { OperatorsModule } from '../operators/operators.module';
import { PaymentsModule } from '../payments/payments.module';
import { AcceptAfterCancelController } from './accept-after-cancel.controller';
import { AdminController } from './admin.controller';
import { PayoutBatchController } from './payout-batch.controller';
import { PayoutBatchService } from './payout-batch.service';

@Module({
  imports: [AuthModule, OperatorsModule, PaymentsModule, ApprovalsCoreModule],
  controllers: [AdminController, AcceptAfterCancelController, PayoutBatchController],
  providers: [PayoutBatchService],
})
export class AdminModule {}
