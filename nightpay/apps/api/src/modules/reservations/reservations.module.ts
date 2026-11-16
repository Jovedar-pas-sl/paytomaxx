import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { PaymentsModule } from '../payments/payments.module';
import { ReservationCatalogService } from './reservation-catalog.service';
import { ReservationOpsService } from './reservation-ops.service';
import { PublicBookingController, PublicReservationController } from './public-reservations.controller';
import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';

/**
 * Reservados con señal y enlaces de RRPP. Los pagos son cobros de recarga del
 * saldo del grupo (PaymentsService, Redsys como /r); lo pagado lo apunta la
 * transición del cobro con el aviso del banco (reservation-ledger.ts).
 */
@Module({
  imports: [PrismaModule, AuditModule, PaymentsModule],
  providers: [ReservationsService, ReservationOpsService, ReservationCatalogService],
  controllers: [ReservationsController, PublicBookingController, PublicReservationController],
})
export class ReservationsModule {}
