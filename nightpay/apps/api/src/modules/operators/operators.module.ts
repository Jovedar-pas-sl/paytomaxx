import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { TreasuryModule } from '../treasury/treasury.module';
import { BankHoldsController } from './bank-holds.controller';
import { BankHoldsService } from './bank-holds.service';
import { OperatorsController } from './operators.controller';
import { OperatorsService } from './operators.service';
import { PayoutAccountBackfill } from './payout-account-backfill';
import { StaffCardsController } from './staff-cards.controller';
import { StaffCardsService } from './staff-cards.service';
import { StaffPushService } from './staff-push.service';
import { StaffQrController } from './staff-qr.controller';

@Module({
  imports: [AuditModule, AuthModule, TreasuryModule],
  controllers: [OperatorsController, StaffQrController, StaffCardsController, BankHoldsController],
  // PayoutAccountBackfill: al arrancar, cifra las cuentas de cobro que quedaran en claro.
  // StaffPushService: «Te han pagado» al móvil de la persona al apuntarle un pago.
  // StaffCardsService: la ficha NFC de la compañera (dar, anular y leerla al cobrar a su nombre).
  providers: [OperatorsService, BankHoldsService, PayoutAccountBackfill, StaffPushService, StaffCardsService],
  exports: [OperatorsService, BankHoldsService],
})
export class OperatorsModule {}
