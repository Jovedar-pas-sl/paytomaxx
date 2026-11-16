import type { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';

/** Lo que identifica un aviso guardado (webhook_deliveries). */
export interface StoredDelivery {
  id: bigint;
  provider: string;
  externalEventId: string;
}

/**
 * Reintentos del procesado de un aviso: 8 intentos, la primera espera de 1 s
 * y cada una el doble (1 + 2 + 4 + … + 64 s = 127 s en total, unos 2 min).
 * Agotados, el repaso de avisos sin procesar (webhook-redrive-sweep) lo
 * vuelve a encolar; mientras siguen los reintentos, el repaso no lo toca.
 */
export const WEBHOOK_JOB_RETRY = {
  attempts: 8,
  backoff: { type: 'exponential', delay: 1_000 },
} as const;

/**
 * Encola el procesado de un aviso (un id de trabajo por aviso: dos entregas,
 * un trabajo). Un aviso que agotó los reintentos deja su trabajo fallido
 * guardado 7 días con ese id, y add() con un id que ya existe no hace nada:
 * el reenvío de la pasarela contestaba 200 y el aviso no se volvía a procesar.
 * Se quita el fallido antes de encolar. Un trabajo en cola, esperando su
 * siguiente reintento o en curso no se toca (add() con su id no hace nada).
 *
 * Devuelve true si el aviso no tenía trabajo (o lo tenía fallido) y se ha
 * encolado; false si ya tenía uno vivo.
 */
export async function enqueueWebhookDelivery(queue: Queue, logger: Logger, d: StoredDelivery): Promise<boolean> {
  const jobId = `webhook-${d.provider}-${d.externalEventId}`;
  const previous = await queue.getJob(jobId);
  const failedBefore = previous ? await previous.isFailed() : false;
  if (previous && failedBefore) {
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
    { jobId, attempts: WEBHOOK_JOB_RETRY.attempts, backoff: { ...WEBHOOK_JOB_RETRY.backoff } },
  );
  return !previous || failedBefore;
}
