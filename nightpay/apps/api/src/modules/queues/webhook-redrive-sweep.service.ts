import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WEBHOOKS_INGEST_QUEUE } from './queue-tokens';
import { enqueueWebhookDelivery, type StoredDelivery } from './webhook-enqueue';

/** Cada cuánto se repasan los avisos sin procesar. */
const SWEEP_EVERY_MS = 60 * 60 * 1000;
/** Primer repaso tras arrancar (sin estorbar el arranque). */
const BOOT_DELAY_MS = 60 * 1000;
/** Margen para no pisar un aviso que aún está en sus reintentos (~75 s). */
const GRACE_MS = 15 * 60 * 1000;
/** Hasta dónde se mira atrás: un aviso que falla siempre no se reintenta sin fin. */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** Como mucho tantos por repaso (el resto, en el siguiente). */
const BATCH_SIZE = 100;

/**
 * Avisos guardados que nunca se procesaron (agotaron los reintentos porque la
 * pasarela no respondía, o no llegaron a encolarse) y que la pasarela no
 * vuelve a mandar: se vuelven a encolar cada hora durante un día. Encolar es
 * idempotente (un id de trabajo por aviso), así que dos réplicas a la vez no
 * lo procesan dos veces; y el procesador no repite un aviso ya procesado.
 */
@Injectable()
export class WebhookRedriveSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookRedriveSweepService.name);
  private readonly prisma: PrismaService;
  private readonly queue: Queue;
  private bootTimer: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;

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

  async sweep(now: Date = new Date()): Promise<{ redriven: number; failed: number }> {
    // webhook_deliveries no es por local (sin RLS): consulta directa.
    const pending: StoredDelivery[] = await this.prisma.webhookDelivery.findMany({
      where: {
        processedAt: null,
        createdAt: { lt: new Date(now.getTime() - GRACE_MS), gt: new Date(now.getTime() - LOOKBACK_MS) },
      },
      orderBy: { createdAt: 'asc' },
      take: BATCH_SIZE,
      select: { id: true, provider: true, externalEventId: true },
    });
    let failed = 0;
    for (const d of pending) {
      try {
        await enqueueWebhookDelivery(this.queue, this.logger, d);
      } catch (err) {
        failed += 1;
        this.logger.error(`No se pudo volver a encolar el aviso ${d.id}: ${(err as Error).message}`);
      }
    }
    if (pending.length > 0) {
      this.logger.warn(`Repaso de avisos sin procesar: ${pending.length - failed} reencolados, ${failed} con error`);
    }
    return { redriven: pending.length - failed, failed };
  }

  private async tick(): Promise<void> {
    try {
      await this.sweep();
    } catch (err) {
      this.logger.error(`Fallo en el repaso de avisos sin procesar: ${(err as Error).message}`);
    }
  }
}
