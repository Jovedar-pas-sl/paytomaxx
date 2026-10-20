import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { IncidentsModule } from '../incidents/incidents.module';
import { MoneyMapModule } from '../money-map/money-map.module';
import { ReportsModule } from '../reports/reports.module';
import { CloseCheckService } from './close-check.service';
import { NightsAutoCloseService } from './nights-autoclose.service';
import { NightsController } from './nights.controller';
import { NightsService } from './nights.service';

/** Noche del local: abrir, cerrar en pasos con arqueo de caja y Z congelado (con su mapa del dinero), y cierre automático. */
@Module({
  imports: [AuthModule, ReportsModule, IncidentsModule, MoneyMapModule],
  controllers: [NightsController],
  providers: [NightsService, NightsAutoCloseService, CloseCheckService],
})
export class NightsModule {}
