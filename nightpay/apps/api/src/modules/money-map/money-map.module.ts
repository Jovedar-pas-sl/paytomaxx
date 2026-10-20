import { Module } from '@nestjs/common';
import { CobrosController } from './cobros.controller';
import { CobrosService } from './cobros.service';
import { WalletFichaService } from './wallet-ficha.service';

/** El mapa del dinero en el panel: lista de cobros con sus filtros y fichas. */
@Module({
  controllers: [CobrosController],
  providers: [CobrosService, WalletFichaService],
})
export class MoneyMapModule {}
