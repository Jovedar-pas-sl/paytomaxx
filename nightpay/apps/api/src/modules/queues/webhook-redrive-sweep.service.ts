import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WEBHOOKS_INGEST_QUEUE } from './queue-tokens';
import { enqueueWebhookDelivery, type StoredDelivery } from './webhook-enqueue';

/** Cada cuánto se repasan los avisos recientes sin procesar. */
export const SWEEP_EVERY_MS = 60 * 1000;
/** Cada cuánto se repasan también los antiguos (los de más de FAST_WINDOW_MS). */
export const SLOW_SWEEP_EVERY_MS = 60 * 60 * 1000;
/** Primer repaso tras arrancar (sin estorbar el arranque). Ese primero lo mira todo. */
const BOOT_DELAY_MS = 60 * 1000;
/**
 * Solo avisos sin procesar de más de 2 min: lo normal es que se procesen en
 * menos de 1 s. Uno que aún está en sus reintentos (unos 2 min, ver
 * WEBHOOK_JOB_RETRY) no se pisa: su trabajo sigue en la cola con su id y
 * encolarlo otra vez no hace nada.
 */
export const GRACE_MS = 2 * 60 * 1000;
/**
 * Los avisos de menos de 10 min se repasan cada minuto: un fallo pasajero (Redis
 * o la base un momento) se arregla solo y el «Pagado» llega en unos 3 min. Los
 * más antiguos, cada hora: así un aviso que falla siempre deja su trabajo
 * fallido a la vista más de 10 min (salta la alerta QueueFailedJobs, ver
 * docs/observability/alerts.yml) y no se reintenta cada pocos minutos todo el día.
 */
export const FAST_WINDOW_MS = 10 * 60 * 1000;
/** Hasta dónde se mira atrás: un aviso que falla siempre no se reintenta sin fin. */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** Como mucho tantos por repaso y tramo (el resto, en el siguiente). */
const BATCH_SIZE = 100;

/**
 * Avisos guardados que nunca se procesaron (agotaron los reintentos porque la
 * pasarela no respondía, o no llegaron a encolarse porque Redis falló justo
 * entonces) y que la pasarela no vuelve a mandar: se vuelven a encolar, cada
 * minuto los recientes y cada hora los antiguos, durante un día. Encolar es
 * idempotente (un id de trabajo por aviso): dos réplicas a la vez, o un aviso
 * que aún reintenta, no se procesan dos veces; y el procesador no repite un
 * aviso ya procesado (processedAt, y el cobro bloqueado con FOR UPDATE en
 * transition()).
 */
@Injectable()
export class WebhookRedriveSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookRedriveSweepService.name);
  private readonly prisma: PrismaService;
  private readonly queue: Queue;
  private bootTimer: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;
  /** Último repaso que miró también los antiguos (0: aún ninguno, el primero lo hace). */
  private lastFullSweepAt = 0;

  constructor(@Inject(PrismaService) prisma: PrismaService, @InjectQueue(WEBHOOKS_INGEST_QUEUE) queue: Queue) {
    this.prisma = prisma;
    this.queue = queue;
  }

  onModuleInit(): void {
    if (process.env.NIGHTPAY_DISABLE_WEBHOOK_SWEEP === '1' || process.env.NODE_ENV === 'test') return;
    this.bootTimer = setTimeout(() => void this.tick(), BOOT_DELAY_MS);
    this.bootTimer.unref();
    this.timer = setInterval(() => void this.tick(), SWEEP_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.bootTimer) clearTimeout(this.bootTimer);
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Vuelve a encolar los avisos sin procesar: siempre los recientes (de 2 a
   * 10 min) y, con `includeOld`, también los antiguos (de 10 min a 24 h).
   */
  async sweep(now: Date = new Date(), opts: { includeOld?: boolean } = {}): Promise<{ redriven: number; failed: number }> {
    const at = now.getTime();
    const fastFrom = new Date(at - FAST_WINDOW_MS);
    const recent = await this.findUnprocessed({ gte: fastFrom, lt: new Date(at - GRACE_MS) });
    const old = (opts.includeOld ?? true) ? await this.findUnprocessed({ gt: new Date(at - LOOKBACK_MS), lt: fastFrom }) : [];
    const pending: StoredDelivery[] = [...recent, ...old];
    let redriven = 0;
    let failed = 0;
    for (const d of pending) {
      try {
        // false: su trabajo sigue en la cola (esperando o en sus reintentos): no se toca.
        if (await enqueueWebhookDelivery(this.queue, this.logger, d)) redriven += 1;
      } catch (err) {
        failed += 1;
        this.logger.error(`No se pudo volver a encolar el aviso ${d.id}: ${(err as Error).message}`);
      }
    }
    if (redriven > 0 || failed > 0) {
      this.logger.warn(`Repaso de avisos sin procesar: ${redriven} reencolados, ${failed} con error`);
    }
    return { redriven, failed };
  }

  /**
   * Avisos sin procesar creados en ese tramo, los más viejos primero.
   * webhook_deliveries no es por local (sin RLS): consulta directa.
   */
  private findUnprocessed(createdAt: { gt?: Date; gte?: Date; lt: Date }): Promise<StoredDelivery[]> {
    return this.prisma.webhookDelivery.findMany({
      where: { processedAt: null, createdAt },
      orderBy: { createdAt: 'asc' },
      take: BATCH_SIZE,
      select: { id: true, provider: true, externalEventId: true },
    });
  }

  private async tick(now: Date = new Date()): Promise<void> {
    // Un repaso lento (Redis caído: las órdenes esperan a que vuelva) no se solapa con el siguiente.
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const includeOld = now.getTime() - this.lastFullSweepAt >= SLOW_SWEEP_EVERY_MS;
      await this.sweep(now, { includeOld });
      if (includeOld) this.lastFullSweepAt = now.getTime();
    } catch (err) {
      this.logger.error(`Fallo en el repaso de avisos sin procesar: ${(err as Error).message}`);
    } finally {
      this.sweeping = false;
    }
  }
}
