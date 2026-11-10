import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { TelegramService } from '../incidents/telegram.service';
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
import { ReceptionContactController } from './reception-contact.controller';
import { WalletContactService } from './wallet-contact.service';
import { ReceptionFichaNumberController } from './reception-ficha-number.controller';
import { ReceptionActivationLinkController } from './reception-activation-link.controller';
import { WalletActivationLinkService } from './wallet-activation-link.service';
import { WalletActivationUseService } from './wallet-activation-use.service';
import { PublicWalletActivationController } from './public-wallet-activation.controller';
import { PublicWalletLostCardController } from './public-wallet-lost-card.controller';
import { WalletLostCardService } from './wallet-lost-card.service';
import { CashTopUpService } from './wallet-cash-topup.service';
import { WalletCardsController } from './wallet-cards.controller';
import { WalletCardsService } from './wallet-cards.service';
import { PendingTopUpsController } from './pending-topups.controller';
import { PendingTopUpService } from './wallet-pending-topup.service';
import { WalletViewGuard } from './wallet-view.guard';
import { WalletEventsModule } from '../wallet-events/wallet-events.module';
import { PublicWalletEventsController } from './public-wallet-events.controller';
import { WalletWelcomeService } from '../home-topup/wallet-welcome.service';
import { CobroDetailModule } from '../money-map/cobro-detail.module';

@Module({
  // AuthModule: TotpService (2FA del encargado al anular y al devolver en efectivo).
  // WalletEventsModule: los avisos del saldo al momento (GET /w/:token/events).
  // CobroDetailModule: el detalle de un pago en la página del saldo (GET /w/:token/movements/:kind/:id).
  imports: [PrismaModule, AuditModule, AuthModule, WalletEventsModule, CobroDetailModule],
  // WalletTopUpService: «Recargar» desde /w (usa PaymentsService con ModuleRef).
  providers: [
    WalletContactService,
    // Aviso al anular un cobro con saldo.
    TelegramService,
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
    // QR de activación de la pantalla «Cargado» de recepción.
    WalletActivationLinkService,
    // Gastar ese QR (un solo uso, 10 min) al activar Face ID o el primer PIN (M-2).
    WalletActivationUseService,
    // «He perdido mi NFC» desde la página del saldo.
    WalletLostCardService,
    // «Cargar saldo antes de llegar» en la página del saldo: el QR de la ficha y la cookie del enlace del local.
    WalletWelcomeService,
  ],
  controllers: [
    // El teléfono opcional al dar una ficha nueva (y buscar un saldo por él).
    ReceptionContactController,
    WalletsController,
    AdminWalletsController,
    WalletChargesController,
    PublicWalletCardController,
    PublicWalletController,
    // El QR de activación en el móvil del cliente (/w/a/:token).
    PublicWalletActivationController,
    // «Saldo al momento»: la página del saldo se entera de los cambios (SSE).
    PublicWalletEventsController,
    PublicWalletLostCardController,
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
    ReceptionActivationLinkController,
    PendingTopUpsController,
    WalletCardsController,
  ],
  // GoogleWalletService: lo usa el repaso de la cola google-wallet-sync (QueuesModule).
  // CashTopUpService y WalletCardsService: la recepción del datáfono (PosDeviceModule).
  exports: [WalletsService, WalletChargesService, WalletPasskeysService, GoogleWalletService, CashTopUpService, WalletCardsService, FichaNumbersService],
})
export class WalletsModule {}
