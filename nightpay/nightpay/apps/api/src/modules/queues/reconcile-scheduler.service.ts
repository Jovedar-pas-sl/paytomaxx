import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RECONCILIATION_QUEUE } from './queue-tokens';

/**
 * Encola el job de reconciliacion diaria a las 07:00 (Europe/Madrid) para
 * cada venue activo.
 *
 * Usamos BullMQ repeatable job — idempotente por jobId pattern.
 */
@Injectable()
export class ReconcileSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(ReconcileSchedulerService.name);
  private readonly prisma: PrismaService;
  private readonly queue: Queue;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @InjectQueue(RECONCILIATION_QUEUE) queue: Queue,
  ) {
    this.prisma = prisma;
    this.queue = queue;
  }

  async onModuleInit(): Promise<void> {
    if (process.env.NIGHTPAY_DISABLE_RECONCILE === '1') {
      this.logger.warn('Reconciliation scheduler disabled via NIGHTPAY_DISABLE_RECONCILE=1');
      return;
    }

    // Listar venues una vez al boot. Si añades venues nuevos, reinicia API
    // (o invocar refresh manual via CLI — fuera de scope MVP).
    const venues = await this.prisma.venue.findMany({
      where: { deletedAt: null },
      select: { id: true, slug: true },
    });

    for (const venue of venues) {
      // Repeatable job: cada dia a las 07:00 UTC. Reconcilia el dia ANTERIOR.
      await this.queue.add(
        'reconcile-daily',
        { tenantId: venue.id, day: yesterdayUtcDate() },
        {
          repeat: { pattern: '0 7 * * *' },
          jobId: `reconcile-${venue.id}`,
          removeOnComplete: { count: 30 },
          removeOnFail: { age: 14 * 24 * 3600 },
        },
      );
    }
    this.logger.log(`Reconciliation scheduled for ${venues.length} venues (07:00 UTC daily)`);
  }
}

function yesterdayUtcDate(): string {
  const d = new Date(Date.now() - 24 * 3600 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
