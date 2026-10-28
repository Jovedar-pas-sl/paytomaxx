import { Module } from '@nestjs/common';
import { TelegramService } from '../incidents/telegram.service';
import { MoneyMapModule } from '../money-map/money-map.module';
import { OxioPaySettlementsCron } from './oxiopay-settlements.cron';
import { OxioPaySettlementsService } from './oxiopay-settlements.service';
import { OwnerOxioPaySettlementsController } from './owner-settlements.controller';

/**
 * «Liquidación OxioPay»: lo que cada local debe a OxioPay por semana (las
 * cifras del mapa del dinero), el repaso del lunes, el aviso de las que llevan
 * más de 7 días sin pagar y el panel del dueño. La consola del super-admin
 * (superadmin/settlements.*) usa el servicio con su 2FA y su registro.
 */
@Module({
  imports: [MoneyMapModule],
  controllers: [OwnerOxioPaySettlementsController],
  providers: [OxioPaySettlementsService, OxioPaySettlementsCron, TelegramService],
  exports: [OxioPaySettlementsService],
})
export class OxioPaySettlementsModule {}
