import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { ChargeAlertService } from './charge-alert.service';

/**
 * «Aviso en cada cobro» (Web Push al móvil del cliente), aparte: lo usan el
 * saldo (WalletsModule: cobros, «No he sido yo») y la API de socios
 * (PartnerModule: «Carga anulada»), como WalletLiveCodeModule.
 */
@Module({
  imports: [PrismaModule],
  providers: [ChargeAlertService],
  exports: [ChargeAlertService],
})
export class ChargeAlertModule {}
