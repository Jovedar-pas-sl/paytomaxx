import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PartySettingsController } from './party-settings.controller';
import { StallsController } from './stalls.controller';
import { StallsService } from './stalls.service';

/**
 * OxioParty (EDITION=party): casetas y ajustes de la fiesta. Con OxioPay
 * (EDITION=club, por defecto) el módulo existe pero sus rutas responden 404.
 * El sellado de la caseta en los cobros y el «fiesta terminada» viven en
 * stall-seal.ts y event-window.ts, que usan los cobros y el saldo.
 */
@Module({
  imports: [AuthModule],
  controllers: [PartySettingsController, StallsController],
  providers: [StallsService],
})
export class PartyModule {}
