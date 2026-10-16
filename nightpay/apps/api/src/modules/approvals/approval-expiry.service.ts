import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ApprovalRequestsService } from './approval-requests.service';

/** Cada cuánto se repasan las solicitudes caducadas. */
const SWEEP_EVERY_MS = 10 * 60 * 1000;

/**
 * Repaso periódico: las solicitudes pendientes de más de 24 h pasan a
 * caducadas (y quedan en el registro). No hace falta para la seguridad (una
 * pendiente de más de 24 h ya no reserva ni se puede aprobar, y al leerlas se
 * caducan), solo para que la base diga lo que hay. Con varias réplicas da
 * igual que lo hagan todas: el cambio es solo de PENDING a EXPIRED.
 */
@Injectable()
export class ApprovalExpiryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ApprovalExpiryService.name);
  private readonly requests: ApprovalRequestsService;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(@Inject(ApprovalRequestsService) requests: ApprovalRequestsService) {
    this.requests = requests;
  }

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), SWEEP_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now: Date = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const expired = await this.requests.expireStale(now);
      if (expired > 0) this.logger.log(`${expired} solicitud(es) sin decidir en 24 h: caducadas`);
      return expired;
    } catch (err) {
      this.logger.error(`No se pudieron caducar las solicitudes: ${(err as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
