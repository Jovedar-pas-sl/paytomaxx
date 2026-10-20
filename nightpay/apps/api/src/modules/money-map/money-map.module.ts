import { Module } from '@nestjs/common';
import { ReportsModule } from '../reports/reports.module';
import { CobrosController } from './cobros.controller';
import { CobrosService } from './cobros.service';
import { MoneyMapController } from './money-map.controller';
import { MoneyMapService } from './money-map.service';
import { WalletFichaService } from './wallet-ficha.service';

/**
 * El mapa del dinero en el panel: los cinco carriles (en directo y congelados
 * en el Z: las noches lo usan al cerrar), la lista de cobros con sus filtros y fichas.
 */
@Module({
  imports: [ReportsModule],
  controllers: [CobrosController, MoneyMapController],
  providers: [CobrosService, WalletFichaService, MoneyMapService],
  exports: [MoneyMapService],
})
export class MoneyMapModule {}
