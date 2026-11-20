import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { PaymentsModule } from '../payments/payments.module';
import { WalletsModule } from '../wallets/wallets.module';
import { HomeTopUpSettingsController } from './home-topup-settings.controller';
import { HomeTopUpSettingsService } from './home-topup-settings.service';
import { HomeTopUpService } from './home-topup.service';
import { PublicHomeTopUpController } from './public-home-topup.controller';
import { HomeTopUpGiftService } from './home-topup-gift.service';
import { PublicHomeTopUpGiftController } from './public-home-topup-gift.controller';
import { ReceptionFichaController } from './reception-ficha.controller';
import { ReceptionFichaService } from './reception-ficha.service';

/**
 * «Cargar saldo antes de llegar»: el enlace público del local (/r/<código>),
 * su interruptor en Ajustes y la ficha en recepción para el saldo cargado
 * desde casa. Lo que añade a la página del saldo (WalletWelcomeService) lo
 * registra WalletsModule (es de esa página).
 * PaymentsModule: la carga es un cobro de recarga de siempre (PaymentsService).
 * WalletsModule: el PIN del cliente al darle la ficha (WalletChargesService).
 * «Regala una noche» (HomeTopUpGiftService): la página del regalo y «Guardar
 * en mi móvil», que emite el QR de activación de siempre (/w/a).
 */
@Module({
  imports: [PrismaModule, AuditModule, PaymentsModule, WalletsModule],
  providers: [HomeTopUpService, HomeTopUpSettingsService, ReceptionFichaService, HomeTopUpGiftService],
  controllers: [PublicHomeTopUpController, PublicHomeTopUpGiftController, HomeTopUpSettingsController, ReceptionFichaController],
})
export class HomeTopUpModule {}
