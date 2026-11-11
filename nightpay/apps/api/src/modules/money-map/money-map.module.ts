import { Module } from '@nestjs/common';
import { ReportsModule } from '../reports/reports.module';
import { CobroDetailModule } from './cobro-detail.module';
import { OwnCobrosController } from './own-cobros.controller';
import { CobrosController } from './cobros.controller';
import { CobrosService } from './cobros.service';
import { MoneyMapController } from './money-map.controller';
import { MoneyMapService } from './money-map.service';
import { StaffFichaService } from './staff-ficha.service';
import { WalletFichaService } from './wallet-ficha.service';

/**
 * El mapa del dinero en el panel: los cinco carriles (en directo y congelados
 * en el Z: las noches lo usan al cerrar), la lista de cobros con sus filtros y fichas.
 */
@Module({
  // CobroDetailModule: el detalle de un cobro (panel y app del personal).
  imports: [ReportsModule, CobroDetailModule],
  controllers: [OwnCobrosController, CobrosController, MoneyMapController],
  providers: [CobrosService, WalletFichaService, MoneyMapService, StaffFichaService],
  exports: [MoneyMapService],
})
export class MoneyMapModule {}
