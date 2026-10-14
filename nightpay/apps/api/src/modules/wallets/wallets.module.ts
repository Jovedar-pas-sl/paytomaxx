import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { PublicWalletController } from './public-wallet.controller';
import { WalletChargesController } from './wallet-charges.controller';
import { WalletChargesService } from './wallet-charges.service';
import { AdminWalletsController, WalletsController } from './wallets.controller';
import { ClientDevicesService } from './client-devices.service';
import { WalletsService } from './wallets.service';

@Module({
  imports: [PrismaModule, AuditModule],
  providers: [WalletsService, WalletChargesService, ClientDevicesService],
  controllers: [WalletsController, AdminWalletsController, WalletChargesController, PublicWalletController],
  exports: [WalletsService, ClientDevicesService],
})
export class WalletsModule {}
