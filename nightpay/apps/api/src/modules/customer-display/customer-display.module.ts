import { Module } from '@nestjs/common';
import { WalletsModule } from '../wallets/wallets.module';
import { CustomerDisplayController } from './customer-display.controller';
import { CustomerDisplayService } from './customer-display.service';
import { DisplayGuard } from './display.guard';

/**
 * «Pantalla del cliente». RealtimeGateway, PrismaService y AuditService vienen
 * de módulos globales; WalletsModule, el pago con ficha (el mismo servicio que
 * usa el móvil del personal).
 */
@Module({
  imports: [WalletsModule],
  controllers: [CustomerDisplayController],
  providers: [CustomerDisplayService, DisplayGuard],
})
export class CustomerDisplayModule {}
