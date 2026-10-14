import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { PublicWalletController } from './public-wallet.controller';
import { WalletChargesController } from './wallet-charges.controller';
import { WalletChargesService } from './wallet-charges.service';
import { AdminWalletsController, WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';

@Module({
  imports: [PrismaModule, AuditModule],
  providers: [WalletsService, WalletChargesService],
  controllers: [WalletsController, AdminWalletsController, WalletChargesController, PublicWalletController],
  exports: [WalletsService],
})
export class WalletsModule {}
