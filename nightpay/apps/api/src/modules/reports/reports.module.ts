import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PeriodReportsController } from './period-reports.controller';
import { PeriodReportsService } from './period-reports.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

/**
 * Informes: CSV para la gestoría (Fase 1C) y, con las mismas reglas
 * (reporting-sql.ts), métricas del panel, Z de un periodo e IVA 303.
 */
@Module({
  imports: [AuthModule],
  controllers: [ReportsController, PeriodReportsController],
  providers: [ReportsService, PeriodReportsService],
  exports: [ReportsService, PeriodReportsService],
})
export class ReportsModule {}
