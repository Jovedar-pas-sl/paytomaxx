import type { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';

/**
 * Conciliación de un cobro sin aviso del banco: 5 intentos con espera
 * creciente (30 s, 1 min, 2 min, 4 min). Agotados sin aprobación, el
 * procesador lo deja ORPHAN (Incidencias). Los fallidos se guardan (los 100
 * últimos) para poder mirarlos.
 */
export const ORPHAN_RECONCILE_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: true,
  removeOnFail: 100,
} as const;

export interface OrphanReconcileJobData {
  paymentId: string;
  tenantId: string;
}

/**
 * Encola la conciliación de un cobro (un trabajo por cobro: el id es fijo).
 * Si el anterior agotó los reintentos por un error (la base o Redis caídos
 * unos minutos) queda guardado como fallido con ese id, y add() con un id que
 * ya existe no hace nada: ni el barrido del arranque volvía a conciliar el
 * cobro, que se quedaba AUTHORIZING con la tarjeta cobrada. Se quita el
 * fallido antes de encolar, como enqueueWebhookDelivery. Uno en cola o en
 * curso no se toca (add() lo deja como está).
 */
export async function enqueueOrphanReconcile(
  queue: Queue,
  logger: Pick<Logger, 'warn'>,
  data: OrphanReconcileJobData,
  delayMs: number,
): Promise<void> {
  const jobId = `orphan-${data.paymentId}`;
  const previous = await queue.getJob(jobId);
  if (previous && (await previous.isFailed())) {
    try {
      await previous.remove();
      logger.warn(`conciliación ${jobId}: había agotado los reintentos — se vuelve a encolar`);
    } catch (err) {
      // Otra réplica (u otra petición) ya lo quitó y lo encola ella.
      logger.warn(`conciliación ${jobId}: no se pudo quitar el trabajo fallido: ${(err as Error).message}`);
    }
  }
  await queue.add('orphan-reconcile', data, { jobId, delay: delayMs, ...ORPHAN_RECONCILE_JOB_OPTIONS });
}
