import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OperatorsModule } from '../operators/operators.module';
import { RefundsModule } from '../refunds/refunds.module';
import { ApprovalExpiryService } from './approval-expiry.service';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsCoreModule } from './approvals-core.module';
import { ApprovalsService } from './approvals.service';

/** «Por aprobar»: listar, aprobar (hace lo pedido), rechazar y caducar. */
@Module({
  imports: [ApprovalsCoreModule, AuthModule, OperatorsModule, RefundsModule],
  controllers: [ApprovalsController],
  providers: [ApprovalsService, ApprovalExpiryService],
})
export class ApprovalsModule {}
