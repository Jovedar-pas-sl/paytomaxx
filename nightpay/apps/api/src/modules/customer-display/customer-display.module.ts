import { Module } from '@nestjs/common';
import { CustomerDisplayController } from './customer-display.controller';
import { CustomerDisplayService } from './customer-display.service';
import { DisplayGuard } from './display.guard';

/** «Pantalla del cliente». RealtimeGateway, PrismaService y AuditService vienen de módulos globales. */
@Module({
  controllers: [CustomerDisplayController],
  providers: [CustomerDisplayService, DisplayGuard],
})
export class CustomerDisplayModule {}
