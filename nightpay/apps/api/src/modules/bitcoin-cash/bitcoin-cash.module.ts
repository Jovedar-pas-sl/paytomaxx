import { Module } from '@nestjs/common';
import { ApprovalsCoreModule } from '../approvals/approvals-core.module';
import { AuthModule } from '../auth/auth.module';
import { PaymentsModule } from '../payments/payments.module';
import { BitcoinCashController } from './bitcoin-cash.controller';
import { BitcoinCashService } from './bitcoin-cash.service';

/** Devolver en efectivo lo pagado con bitcoin (Fases B y C). Apagado de fábrica en cada local. */
@Module({
  imports: [ApprovalsCoreModule, AuthModule, PaymentsModule],
  controllers: [BitcoinCashController],
  providers: [BitcoinCashService],
})
export class BitcoinCashModule {}
