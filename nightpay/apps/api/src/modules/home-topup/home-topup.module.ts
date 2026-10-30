import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { PaymentsModule } from '../payments/payments.module';
import { WalletsModule } from '../wallets/wallets.module';
import { HomeTopUpSettingsController } from './home-topup-settings.controller';
import { HomeTopUpSettingsService } from './home-topup-settings.service';
import { HomeTopUpService } from './home-topup.service';
import { PublicHomeTopUpController } from './public-home-topup.controller';

/**
 * «Cargar saldo antes de llegar»: el enlace público del local (/r/<código>),
 * su interruptor en Ajustes y la ficha en recepción para el saldo cargado
 * desde casa. Lo que añade a la página del saldo (WalletWelcomeService) lo
 * registra WalletsModule (es de esa página).
 * PaymentsModule: la carga es un cobro de recarga de siempre (PaymentsService).
 * WalletsModule: lo que comparte con la página del saldo.
 */
@Module({
  imports: [PrismaModule, AuditModule, PaymentsModule, WalletsModule],
  providers: [HomeTopUpService, HomeTopUpSettingsService],
  controllers: [PublicHomeTopUpController, HomeTopUpSettingsController],
})
export class HomeTopUpModule {}
