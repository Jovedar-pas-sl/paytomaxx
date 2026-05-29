import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { Prisma } from '@nightpay/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Provider } from '@nightpay/contracts';
import { RECONCILIATION_QUEUE } from './queue-tokens';

interface ReconcileDailyJobData {
  // YYYY-MM-DD del dia A RECONCILIAR (normalmente ayer)
  day: string;
  tenantId: string;
}

/**
 * Job diario de reconciliacion (07:00 AM).
 *
 * MVP: agregamos los pagos AUTHORIZED|PARTIALLY_REFUNDED|REFUNDED del dia
 * por (venue, provider) y dejamos un registro `Reconciliation` con status OK.
 *
 * v2 (cuando integremos pasarela real): comparar contra export de Wipay/Peanpe
 * y marcar MISMATCH si hay desfase. Por ahora `gatewayTotalCents = localTotalCents`
 * porque los mocks no exponen export.
 */
@Processor(RECONCILIATION_QUEUE)
export class ReconcileDailyProcessor extends WorkerHost {
  private readonly logger = new Logger(ReconcileDailyProcessor.name);
  private readonly prisma: PrismaService;

  constructor(@Inject(PrismaService) prisma: PrismaService) {
    super();
    this.prisma = prisma;
  }

  async process(job: Job<ReconcileDailyJobData>): Promise<void> {
    const { day, tenantId } = job.data;
    const dayDate = new Date(`${day}T00:00:00Z`);
    const dayEnd = new Date(dayDate.getTime() + 24 * 3600 * 1000);

    // Agregamos por provider en ese rango temporal.
    // REDSYS + PAYTEF añadidos — antes faltaban y la reconciliación era ciega
    // a discrepancias en la pasarela más usada (Redsys/BBVA).
    const providers: Provider[] = ['WIPAY', 'PEANPE', 'REDSYS', 'PAYTEF'];

    // H3: PEANPE NO expone export ni status API, por lo que el "gateway total"
    // calculado es siempre igual al "local total" → MISMATCH es indetectable.
    // La fila Reconciliation queda como auditoría histórica pero NO indica
    // discrepancias reales. Reconciliación REAL para PEANPE requiere export
    // manual del panel peanpe.com (TODO post-MVP).
    const providersWithoutExport: Provider[] = ['PEANPE'];

    for (const provider of providers) {
      const agg = await this.prisma.payment.aggregate({
        where: {
          tenantId,
          provider,
          createdAt: { gte: dayDate, lt: dayEnd },
          status: { in: ['AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
        },
        _sum: { amountCents: true },
        _count: { _all: true },
      });

      const localTotalCents = agg._sum.amountCents ?? 0;

      // Mock: gateway = local. v2 -> fetch real export y comparar.
      const gatewayTotalCents = localTotalCents;
      const diff = localTotalCents - gatewayTotalCents;
      const status = diff === 0 ? 'OK' : 'MISMATCH';
      const isBestEffort = providersWithoutExport.includes(provider);
      if (isBestEffort && agg._count._all > 0) {
        this.logger.warn(
          `Reconcile ${provider} ${day}: BEST-EFFORT (no gateway export available) — ` +
            `${agg._count._all} pagos / ${localTotalCents}c locales. Verifica manualmente en panel ${provider.toLowerCase()}.com.`,
        );
      }

      await this.prisma.reconciliation.upsert({
        where: {
          tenantId_provider_day: {
            tenantId,
            provider,
            day: dayDate,
          },
        },
        update: {
          localTotalCents,
          gatewayTotalCents,
          diffCents: diff,
          status,
          discrepancies: status === 'OK' ? Prisma.JsonNull : { count: agg._count._all },
          runAt: new Date(),
        },
        create: {
          tenantId,
          provider,
          day: dayDate,
          localTotalCents,
          gatewayTotalCents,
          diffCents: diff,
          status,
        },
      });

      this.logger.log(
        `Reconcile ${tenantId} ${provider} ${day}: ${status} local=${localTotalCents}c diff=${diff}c`,
      );
    }
  }
}
