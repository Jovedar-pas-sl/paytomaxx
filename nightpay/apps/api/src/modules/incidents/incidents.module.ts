import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ReportsModule } from '../reports/reports.module';
import { AlertsService } from './alerts.service';
import { IncidentsController } from './incidents.controller';
import { IncidentsService } from './incidents.service';
import { TelegramService } from './telegram.service';

/** Bandeja de incidencias, alertas por Telegram y resumen de las 9:00 (Fase 1E). */
@Module({
  imports: [AuthModule, ReportsModule],
  controllers: [IncidentsController],
  providers: [IncidentsService, TelegramService, AlertsService],
})
export class IncidentsModule {}
