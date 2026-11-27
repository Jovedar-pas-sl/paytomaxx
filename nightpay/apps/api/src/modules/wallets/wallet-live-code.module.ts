import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { WalletLiveCodeService } from './wallet-live-code.service';

/**
 * El código del móvil del saldo (WalletLiveCodeService) aparte de
 * WalletsModule: lo importan WalletsModule (la página lo da y las anulaciones)
 * y PartnerModule (lo lee la API de socios) sin traerse todo WalletsModule.
 */
@Module({
  imports: [PrismaModule],
  providers: [WalletLiveCodeService],
  exports: [WalletLiveCodeService],
})
export class WalletLiveCodeModule {}
