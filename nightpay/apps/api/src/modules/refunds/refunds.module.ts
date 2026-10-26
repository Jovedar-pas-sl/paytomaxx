import { Module } from '@nestjs/common';
import { ApprovalsCoreModule } from '../approvals/approvals-core.module';
import { AuthModule } from '../auth/auth.module';
import { PaymentsModule } from '../payments/payments.module';
import { RefundReversalSweepService } from './refund-reversal-sweep.service';
import { RefundsController } from './refunds.controller';
import { RefundsService } from './refunds.service';
import { REFUNDS_SERVICE } from './refunds.token';

@Module({
  imports: [PaymentsModule, AuthModule, ApprovalsCoreModule],
  controllers: [RefundsController],
  // El repaso reintenta los descuentos a la chica que no llegaron a aplicarse.
  // REFUNDS_SERVICE: el mismo servicio por su nombre, para el saldo (ver refunds.token.ts).
  providers: [RefundsService, RefundReversalSweepService, { provide: REFUNDS_SERVICE, useExisting: RefundsService }],
  exports: [RefundsService, REFUNDS_SERVICE],
})
export class RefundsModule {}
