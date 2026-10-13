import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { NightsService } from './nights.service';

/** Cada cuánto se miran las noches que nadie cerró antes de las 08:00. */
const AUTO_CLOSE_EVERY_MS = 10 * 60 * 1000;

/**
 * Cierre automático de noches a las 08:00 (Fase 1D). Además del repaso
 * periódico, cada consulta de noches del panel cierra antes las vencidas.
 * El cierre va condicionado (closedAt IS NULL), así que repetirlo no duplica.
 */
@Injectable()
export class NightsAutoCloseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NightsAutoCloseService.name);
  private readonly nights: NightsService;
  private timer: NodeJS.Timeout | null = null;

  constructor(@Inject(NightsService) nights: NightsService) {
    this.nights = nights;
  }

  onModuleInit(): void {
    if (process.env.NIGHTPAY_DISABLE_NIGHT_AUTOCLOSE === '1' || process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), AUTO_CLOSE_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    try {
      const closed = await this.nights.autoCloseDue();
      if (closed > 0) this.logger.log(`Noches cerradas automáticamente: ${closed}`);
    } catch (err) {
      this.logger.error(`Fallo al cerrar noches vencidas: ${(err as Error).message}`);
    }
  }
}
