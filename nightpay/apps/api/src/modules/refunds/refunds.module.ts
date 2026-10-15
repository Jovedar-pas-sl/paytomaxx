import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PaymentsModule } from '../payments/payments.module';
import { RefundReversalSweepService } from './refund-reversal-sweep.service';
import { RefundsController } from './refunds.controller';
import { RefundsService } from './refunds.service';

@Module({
  imports: [PaymentsModule, AuthModule],
  controllers: [RefundsController],
  // El repaso reintenta los descuentos a la chica que no llegaron a aplicarse.
  providers: [RefundsService, RefundReversalSweepService],
  exports: [RefundsService],
})
export class RefundsModule {}
