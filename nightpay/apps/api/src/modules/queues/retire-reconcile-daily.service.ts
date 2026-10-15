import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { RECONCILIATION_QUEUE } from './queue-tokens';

/** Nombre del trabajo repetido que programaba la versión anterior. */
export const LEGACY_RECONCILE_JOB = 'reconcile-daily';

/**
 * Retira la "conciliación diaria" de las 07:00. Escribía cada día una fila en
 * `reconciliations` con estado OK sin comparar nada (total de la pasarela =
 * total local, siempre), con el día fijado al arrancar el API (siempre el
 * mismo) y en UTC en vez de hora de Madrid. Nadie leía esa tabla. El cuadre
 * de verdad es el del banco: módulo bank-recon (fichero del banco →
 * Incidencias) y el aviso de las 9:00 si falta el fichero.
 *
 * Los trabajos repetidos viven en Redis: si no se quitan, se seguirían
 * creando cada día sin nadie que los procese. Al arrancar se borran (y lo
 * que quedara en cola). La tabla se conserva (histórico, sin migración).
 */
@Injectable()
export class RetireReconcileDailyService implements OnModuleInit {
  private readonly logger = new Logger(RetireReconcileDailyService.name);
  private readonly queue: Queue;

  constructor(@InjectQueue(RECONCILIATION_QUEUE) queue: Queue) {
    this.queue = queue;
  }

  async onModuleInit(): Promise<void> {
    await this.retire();
  }

  /** Devuelve cuántos trabajos repetidos quitó. Nunca rompe el arranque. */
  async retire(): Promise<number> {
    try {
      const repeatables = await this.queue.getRepeatableJobs();
      const legacy = repeatables.filter((r) => r.name === LEGACY_RECONCILE_JOB);
      for (const job of legacy) {
        await this.queue.removeRepeatableByKey(job.key);
      }
      // Lo ya programado (esperando o con retraso) no lo procesará nadie.
      await this.queue.drain(true);
      if (legacy.length > 0) {
        this.logger.log(
          `Conciliación diaria retirada: ${legacy.length} trabajos repetidos quitados (el cuadre real es el del banco)`,
        );
      }
      return legacy.length;
    } catch (err) {
      this.logger.warn(`No se pudo retirar la conciliación diaria antigua: ${(err as Error).message}`);
      return 0;
    }
  }
}
