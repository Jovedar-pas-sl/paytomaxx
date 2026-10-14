import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { PublicWalletController } from './public-wallet.controller';
import { WalletChargesController } from './wallet-charges.controller';
import { WalletChargesService } from './wallet-charges.service';
import { AdminWalletsController, WalletsController } from './wallets.controller';
import { PublicSaldoController } from './public-saldo.controller';
import { WalletPasskeysService } from './wallet-passkeys.service';
import { WalletsService } from './wallets.service';

@Module({
  imports: [PrismaModule, AuditModule],
  providers: [WalletsService, WalletChargesService, WalletPasskeysService],
  controllers: [
    WalletsController,
    AdminWalletsController,
    WalletChargesController,
    PublicWalletController,
    PublicSaldoController,
  ],
  exports: [WalletsService, WalletChargesService, WalletPasskeysService],
})
export class WalletsModule {}
