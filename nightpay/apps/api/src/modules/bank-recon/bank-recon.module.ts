import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BankReconController } from './bank-recon.controller';
import { BankReconService } from './bank-recon.service';

/** Cuadre con el banco: fichero del portal de Redsys o Paytef contra lo apuntado. */
@Module({
  imports: [AuthModule],
  controllers: [BankReconController],
  providers: [BankReconService],
})
export class BankReconModule {}
