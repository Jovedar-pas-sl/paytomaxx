import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PartyPanelController } from './party-panel.controller';
import { PartyPanelService } from './party-panel.service';
import { PartySettingsController } from './party-settings.controller';
import { StallsController } from './stalls.controller';
import { StallsService } from './stalls.service';

/**
 * OxioParty (EDITION=party): casetas, ajustes de la fiesta y el panel del
 * organizador (en directo, la caja de la taquilla y la liquidación por
 * caseta con su fichero SEPA, party-panel.*). Con OxioPay
 * (EDITION=club, por defecto) el módulo existe pero sus rutas responden 404.
 * El sellado de la caseta en los cobros y el «fiesta terminada» viven en
 * stall-seal.ts y event-window.ts, que usan los cobros y el saldo.
 */
@Module({
  imports: [AuthModule],
  controllers: [PartySettingsController, StallsController, PartyPanelController],
  providers: [StallsService, PartyPanelService],
})
export class PartyModule {}
