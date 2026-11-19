import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ReservationOpsService } from './reservation-ops.service';

/** Cada cuánto se miran las reservas que pasan a «No vino» (a las 12:00 del día siguiente). */
const NO_SHOW_EVERY_MS = 10 * 60 * 1000;

/**
 * «No vino» solo: a las 12:00 de Madrid del día siguiente, las reservas
 * pagadas cuyo grupo no ha llegado (ReservationOpsService.autoNoShowDue). Como
 * el cierre automático de las noches: cada 10 min, con la reserva bloqueada
 * (dos réplicas a la vez no lo hacen dos veces). El encargado lo puede deshacer.
 */
@Injectable()
export class ReservationsNoShowService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReservationsNoShowService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(@Inject(ReservationOpsService) private readonly ops: ReservationOpsService) {}

  onModuleInit(): void {
    if (process.env.NIGHTPAY_DISABLE_RESERVATION_NOSHOW === '1' || process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), NO_SHOW_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    try {
      const marked = await this.ops.autoNoShowDue();
      if (marked > 0) this.logger.log(`Reservas marcadas «No vino»: ${marked}`);
    } catch (err) {
      this.logger.error(`Fallo al marcar «No vino»: ${(err as Error).message}`);
    }
  }
}
