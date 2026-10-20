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
import { WalletTopUpService } from './wallet-topup.service';
import { WalletsService } from './wallets.service';
import { GoogleWalletController } from './google-wallet/google-wallet.controller';
import { GoogleWalletService } from './google-wallet/google-wallet.service';
import { PassChargeLinkController } from './google-wallet/pass-charge-link.controller';
import { ReceptionController } from './reception.controller';
import { CashTopUpService } from './wallet-cash-topup.service';
import { WalletCardsController } from './wallet-cards.controller';
import { WalletCardsService } from './wallet-cards.service';
import { PendingTopUpsController } from './pending-topups.controller';
import { PendingTopUpService } from './wallet-pending-topup.service';

@Module({
  // AuthModule: TotpService (2FA del encargado al anular y al devolver en efectivo).
  imports: [PrismaModule, AuditModule, AuthModule],
  // WalletTopUpService: «Recargar» desde /w (usa PaymentsService con ModuleRef).
  providers: [
    WalletsService,
    WalletChargesService,
    WalletPasskeysService,
    GoogleWalletService,
    WalletTopUpService,
    CashTopUpService,
    WalletCardsService,
    // Recargas cobradas sin el NFC del cliente, pendientes de asignar (usa PaymentsService con ModuleRef).
    PendingTopUpService,
  ],
  controllers: [
    WalletsController,
    AdminWalletsController,
    WalletChargesController,
    PublicWalletController,
    PublicSaldoController,
    GoogleWalletController,
    // El QR del pase leído con la cámara del móvil (/c/<token>) → la app del personal.
    PassChargeLinkController,
    // Recepción (recarga en efectivo, «Preparar fichas») y Clientes → Fichas.
    ReceptionController,
    PendingTopUpsController,
    WalletCardsController,
  ],
  // GoogleWalletService: lo usa el repaso de la cola google-wallet-sync (QueuesModule).
  // CashTopUpService y WalletCardsService: la recepción del datáfono (PosDeviceModule).
  exports: [WalletsService, WalletChargesService, WalletPasskeysService, GoogleWalletService, CashTopUpService, WalletCardsService],
})
export class WalletsModule {}
