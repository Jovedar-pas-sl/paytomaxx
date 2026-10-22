import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { PublicWalletCardController } from './public-wallet-card.controller';
import { WalletCardViewService } from './wallet-card-view.service';
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
import { ReceptionCashPayoutController } from './reception-cash-payout.controller';
import { PublicPayoutConfirmController } from './public-payout-confirm.controller';
import { ReceptionPayoutPasskeys } from './reception-payout-passkey';
import { ReceptionPayoutService } from './reception-payout.service';
import { FichaNumbersService } from './ficha-numbers.service';
import { ReceptionFichaNumberController } from './reception-ficha-number.controller';
import { CashTopUpService } from './wallet-cash-topup.service';
import { WalletCardsController } from './wallet-cards.controller';
import { WalletCardsService } from './wallet-cards.service';
import { PendingTopUpsController } from './pending-topups.controller';
import { PendingTopUpService } from './wallet-pending-topup.service';
import { WalletViewGuard } from './wallet-view.guard';

@Module({
  // AuthModule: TotpService (2FA del encargado al anular y al devolver en efectivo).
  imports: [PrismaModule, AuditModule, AuthModule],
  // WalletTopUpService: «Recargar» desde /w (usa PaymentsService con ModuleRef).
  providers: [
    WalletViewGuard,
    WalletCardViewService,
    WalletsService,
    WalletChargesService,
    WalletPasskeysService,
    GoogleWalletService,
    WalletTopUpService,
    CashTopUpService,
    WalletCardsService,
    // Recargas cobradas sin el NFC del cliente, pendientes de asignar (usa PaymentsService con ModuleRef).
    PendingTopUpService,
    // Salida de recepción: NFC + PIN o Face ID del cliente, 2FA del encargado y tope de la noche.
    ReceptionPayoutPasskeys,
    ReceptionPayoutService,
    // El número impreso de las fichas: buscar sin acercarla (resumen) y recargar en efectivo.
    FichaNumbersService,
  ],
  controllers: [
    WalletsController,
    AdminWalletsController,
    WalletChargesController,
    PublicWalletCardController,
    PublicWalletController,
    PublicSaldoController,
    GoogleWalletController,
    // El QR del pase leído con la cámara del móvil (/c/<token>) → la app del personal.
    PassChargeLinkController,
    // Recepción (recarga en efectivo, «Preparar fichas») y Clientes → Fichas.
    ReceptionController,
    ReceptionCashPayoutController,
    // El cliente confirma la salida con su Face ID en su móvil (/w/salida/:token).
    PublicPayoutConfirmController,
    ReceptionFichaNumberController,
    PendingTopUpsController,
    WalletCardsController,
  ],
  // GoogleWalletService: lo usa el repaso de la cola google-wallet-sync (QueuesModule).
  // CashTopUpService y WalletCardsService: la recepción del datáfono (PosDeviceModule).
  exports: [WalletsService, WalletChargesService, WalletPasskeysService, GoogleWalletService, CashTopUpService, WalletCardsService],
})
export class WalletsModule {}
