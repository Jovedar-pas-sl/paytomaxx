import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WalletsModule } from '../wallets/wallets.module';
import { MyStallController } from './my-stall.controller';
import { PartyPanelController } from './party-panel.controller';
import { PartyPanelService } from './party-panel.service';
import { PartyRefundsController } from './party-refunds.controller';
import { PartySettingsController } from './party-settings.controller';
import { PartyWalletController } from './party-wallet.controller';
import { PulserasController } from './pulseras.controller';
import { PulserasService } from './pulseras.service';
import { StallsController } from './stalls.controller';
import { StallsService } from './stalls.service';

/**
 * OxioParty (EDITION=party): casetas, ajustes de la fiesta y el panel del
 * organizador (en directo, la caja de la taquilla y la liquidación por
 * caseta con su fichero SEPA, party-panel.*). Con OxioPay
 * (EDITION=club, por defecto) el módulo existe pero sus rutas responden 404.
 * El sellado de la caseta en los cobros y el «fiesta terminada» viven en
 * stall-seal.ts y event-window.ts, que usan los cobros y el saldo.
 * Pulseras (lote, hoja para imprimir, sustituir la perdida) y «Lo que sobra»
 * (la página de la pulsera y Devoluciones en el panel). PartyRefundsService
 * lo da WalletsModule: la página del saldo (/w/:token) también lo usa.
 */
@Module({
  imports: [AuthModule, WalletsModule],
  controllers: [
    PartySettingsController,
    StallsController,
    // «Abierta ahora» de la caseta de quien entra (la app del personal).
    MyStallController,
    PartyPanelController,
    PulserasController,
    PartyRefundsController,
    PartyWalletController,
  ],
  providers: [StallsService, PartyPanelService, PulserasService],
})
export class PartyModule {}
