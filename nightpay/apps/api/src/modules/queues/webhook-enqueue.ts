import type { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';

/** Lo que identifica un aviso guardado (webhook_deliveries). */
export interface StoredDelivery {
  id: bigint;
  provider: string;
  externalEventId: string;
}

/**
 * Encola el procesado de un aviso (un id de trabajo por aviso: dos entregas,
 * un trabajo). Un aviso que agotó los reintentos deja su trabajo fallido
 * guardado 7 días con ese id, y add() con un id que ya existe no hace nada:
 * el reenvío de la pasarela contestaba 200 y el aviso no se volvía a procesar.
 * Se quita el fallido antes de encolar. Un trabajo en cola o en curso no se toca.
 */
export async function enqueueWebhookDelivery(queue: Queue, logger: Logger, d: StoredDelivery): Promise<void> {
  const jobId = `webhook-${d.provider}-${d.externalEventId}`;
  const previous = await queue.getJob(jobId);
  if (previous && (await previous.isFailed())) {
    try {
      await previous.remove();
      logger.warn(`webhook ${jobId}: había agotado los reintentos — se vuelve a procesar`);
    } catch (err) {
      // Otra entrega (u otra réplica) ya lo quitó y lo encola ella.
      logger.warn(`webhook ${jobId}: no se pudo quitar el trabajo fallido: ${(err as Error).message}`);
    }
  }
  await queue.add(
    'process-webhook',
    { deliveryId: d.id.toString() },
    { jobId, attempts: 5, backoff: { type: 'exponential', delay: 5000 } },
  );
}
