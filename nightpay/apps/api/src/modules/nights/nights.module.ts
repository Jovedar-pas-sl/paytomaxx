import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ReportsModule } from '../reports/reports.module';
import { NightsAutoCloseService } from './nights-autoclose.service';
import { NightsController } from './nights.controller';
import { NightsService } from './nights.service';

/** Noche del local: abrir, cerrar con Z congelado y cierre automático (Fase 1D). */
@Module({
  imports: [AuthModule, ReportsModule],
  controllers: [NightsController],
  providers: [NightsService, NightsAutoCloseService],
})
export class NightsModule {}
