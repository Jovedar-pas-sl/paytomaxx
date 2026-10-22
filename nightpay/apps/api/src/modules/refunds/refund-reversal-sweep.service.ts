import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';
import { MetricsService } from '../metrics/metrics.service';

/** Cada cuánto se repasan las devoluciones sin descontar a la chica. */
const SWEEP_EVERY_MS = 10 * 60 * 1000;
/** Primer repaso tras arrancar (sin estorbar el arranque). */
const BOOT_DELAY_MS = 30 * 1000;
/** Margen para no pisar la petición que la está descontando ahora mismo. */
const GRACE_MS = 2 * 60 * 1000;
/** Como mucho tantas por repaso (el resto, en el siguiente). */
const BATCH_SIZE = 100;
/** Persistent failures leave room for later batches, including after a restart. */
const RETRY_DELAY_MS = 30 * 60 * 1000;

interface MissingReversal {
  refundId: string;
  paymentId: string;
  tenantId: string;
  amountCents: number;
}

/**
 * Devoluciones hechas (SUCCEEDED) cuyo descuento a la chica no llegó a
 * aplicarse: el descuento va en otra transacción y, si falla, antes solo
 * quedaba una incidencia. Este repaso lo reintenta al arrancar y cada 10 min.
 * applyRefundToEarning es idempotente por refundId (earning_reversals), así
 * que repetirlo — o que dos réplicas lo hagan a la vez — no descuenta dos veces.
 */
@Injectable()
export class RefundReversalSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RefundReversalSweepService.name);
  private readonly prisma: PrismaService;
  private readonly payments: PaymentsService;
  private readonly metrics: MetricsService;
  private bootTimer: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private removeMetrics?: () => void;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(PaymentsService) payments: PaymentsService,
    @Inject(MetricsService) metrics: MetricsService,
  ) {
    this.prisma = prisma;
    this.payments = payments;
    this.metrics = metrics;
  }

  onModuleInit(): void {
    this.removeMetrics = this.metrics.observeEarningReversals(() => this.backlog());
    if (process.env.NIGHTPAY_DISABLE_REFUND_SWEEP === '1' || process.env.NODE_ENV === 'test') return;
    this.bootTimer = setTimeout(() => void this.tick(), BOOT_DELAY_MS);
    this.bootTimer.unref();
    this.timer = setInterval(() => void this.tick(), SWEEP_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.removeMetrics?.();
    if (this.bootTimer) clearTimeout(this.bootTimer);
    if (this.timer) clearInterval(this.timer);
  }

  /** Includes deferred failures: retry scheduling must never reset their age. */
  private async backlog(): Promise<{ pending: number; oldestAgeSeconds: number }> {
    const rows = await this.prisma.asSystem((tx) => tx.$queryRaw<Array<{ pending: bigint; oldestAgeSeconds: number }>>`
      SELECT COUNT(*)::bigint AS pending,
             COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(r."createdAt")))::float8, 0) AS "oldestAgeSeconds"
        FROM refunds r
       WHERE r.status = 'SUCCEEDED'
         AND EXISTS (SELECT 1 FROM operator_earnings e WHERE e."paymentId" = r."paymentId")
         AND NOT EXISTS (SELECT 1 FROM earning_reversals er WHERE er."refundId" = r.id)
    `);
    return { pending: Number(rows[0]?.pending ?? 0), oldestAgeSeconds: Math.max(0, rows[0]?.oldestAgeSeconds ?? 0) };
  }

  async sweep(now: Date = new Date()): Promise<{ checked: number; applied: number; failed: number }> {
    const missing = await this.findMissing(now);
    let applied = 0;
    for (const m of missing) {
      if (await this.redrive(m)) applied += 1;
      else await this.prisma.asSystem((tx) => tx.refund.updateMany({
        where: { id: m.refundId, status: 'SUCCEEDED' },
        data: { earningReversalRetryAt: new Date(now.getTime() + RETRY_DELAY_MS) },
      }));
    }
    const failed = missing.length - applied;
    if (missing.length > 0) {
      this.logger.warn(`Repaso de descuentos a chicas: ${applied} aplicados, ${failed} siguen pendientes`);
    }
    return { checked: missing.length, applied, failed };
  }

  private async tick(): Promise<void> {
    try {
      await this.sweep();
    } catch (err) {
      this.logger.error(`Fallo en el repaso de descuentos por devoluciones: ${(err as Error).message}`);
    }
  }

  /**
   * Cruza locales a propósito (tarea del sistema): con el bypass del RLS, que
   * en operator_earnings / earning_reversals es forzado.
   */
  private async findMissing(now: Date): Promise<MissingReversal[]> {
    const before = new Date(now.getTime() - GRACE_MS);
    return this.prisma.asSystem((tx) =>
      tx.$queryRaw<MissingReversal[]>`
        SELECT r.id AS "refundId", r."paymentId", r."tenantId", r."amountCents"
          FROM refunds r
         WHERE EXISTS (SELECT 1 FROM operator_earnings e WHERE e."paymentId" = r."paymentId")
           AND r.status = 'SUCCEEDED'
           AND r."createdAt" < ${before}
           AND (r."earningReversalRetryAt" IS NULL OR r."earningReversalRetryAt" <= ${now})
           AND NOT EXISTS (SELECT 1 FROM earning_reversals er WHERE er."refundId" = r.id)
         ORDER BY COALESCE(r."earningReversalRetryAt", r."createdAt") ASC, r.id ASC
         LIMIT ${BATCH_SIZE}
      `,
    );
  }

  /** true si el descuento quedó apuntado (hay fila en earning_reversals). */
  private async redrive(m: MissingReversal): Promise<boolean> {
    try {
      await this.payments.applyRefundToEarning(m.paymentId, m.refundId, m.amountCents);
      if (await this.reversalExists(m.refundId)) return true;
      this.failed(m, 'applyRefundToEarning no dejó registro (¿no ve el earning?)');
    } catch (err) {
      this.failed(m, (err as Error).message);
    }
    return false;
  }

  private async reversalExists(refundId: string): Promise<boolean> {
    const rows = await this.prisma.asSystem((tx) =>
      tx.$queryRaw<unknown[]>`SELECT 1 AS ok FROM earning_reversals WHERE "refundId" = ${refundId}::uuid`,
    );
    return rows.length > 0;
  }

  private failed(m: MissingReversal, why: string): void {
    this.metrics.earningReversalFailed.inc({ venue: m.tenantId });
    this.logger.error(
      `Repaso: la devolución ${m.refundId} (cobro ${m.paymentId}, ${m.amountCents}c) sigue sin descontarse a la chica: ${why}`,
    );
  }
}
