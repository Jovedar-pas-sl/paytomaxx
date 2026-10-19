import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { PublicWalletController } from './public-wallet.controller';
import { WalletChargesController } from './wallet-charges.controller';
import { WalletChargesService } from './wallet-charges.service';
import { AdminWalletsController, WalletsController } from './wallets.controller';
import { PublicSaldoController } from './public-saldo.controller';
import { WalletPasskeysService } from './wallet-passkeys.service';
import { WalletsService } from './wallets.service';
import { GoogleWalletController } from './google-wallet/google-wallet.controller';
import { GoogleWalletService } from './google-wallet/google-wallet.service';

@Module({
  // AuthModule: TotpService (2FA del encargado al anular y al devolver en efectivo).
  imports: [PrismaModule, AuditModule, AuthModule],
  providers: [WalletsService, WalletChargesService, WalletPasskeysService, GoogleWalletService],
  controllers: [
    WalletsController,
    AdminWalletsController,
    WalletChargesController,
    PublicWalletController,
    PublicSaldoController,
    GoogleWalletController,
  ],
  // GoogleWalletService: lo usa el repaso de la cola google-wallet-sync (QueuesModule).
  exports: [WalletsService, WalletChargesService, WalletPasskeysService, GoogleWalletService],
})
export class WalletsModule {}
