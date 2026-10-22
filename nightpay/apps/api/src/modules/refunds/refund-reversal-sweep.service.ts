import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PaymentsService } from '../payments/payments.service';
import { MetricsService, type ReversalBacklog } from '../metrics/metrics.service';

/** Cada cuánto se repasan las devoluciones sin descontar a la chica. */
const SWEEP_EVERY_MS = 10 * 60 * 1000;
/** Primer repaso tras arrancar (sin estorbar el arranque). */
const BOOT_DELAY_MS = 30 * 1000;
/** Margen para no pisar la petición que la está descontando ahora mismo. */
const GRACE_MS = 2 * 60 * 1000;
/** Como mucho tantas por repaso (el resto, en el siguiente). */
const BATCH_SIZE = 100;
/** Espera tras el primer fallo; se dobla con cada intento, hasta MAX_RETRY_DELAY_MS. */
const FIRST_RETRY_DELAY_MS = 10 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 12 * 60 * 60 * 1000;
/**
 * Con tantos intentos fallidos (unas 5 h) sale en Incidencias con su motivo:
 * sola no se arregla. Se sigue reintentando (cada 12 h como mucho).
 */
export const NEEDS_HUMAN_AFTER_ATTEMPTS = 5;
/** Lo que se guarda del último error (el resto, en el log). */
const MAX_ERROR_LENGTH = 500;

/** Cuánto esperar tras el intento fallido número `attempts` (1, 2, …). */
export function nextRetryDelayMs(attempts: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, FIRST_RETRY_DELAY_MS * 2 ** Math.max(0, attempts - 1));
}

interface MissingReversal {
  refundId: string;
  paymentId: string;
  tenantId: string;
  amountCents: number;
  /** Intentos fallidos del repaso hasta ahora. */
  attempts: number;
}

/**
 * Devoluciones hechas (SUCCEEDED) cuyo descuento a la chica no llegó a
 * aplicarse: el descuento va en otra transacción y, si falla, antes solo
 * quedaba una incidencia. Este repaso lo reintenta al arrancar y cada 10 min.
 * applyRefundToEarning es idempotente por refundId (earning_reversals), así
 * que repetirlo — o que dos réplicas lo hagan a la vez — no descuenta dos veces.
 *
 * Una que falla no vuelve hasta su siguiente intento (cada vez más tarde): cien
 * fallos persistentes no tapan a la 101, porque cada repaso coge las que ya
 * tocan, la que más tiempo lleva esperando primero (también tras reiniciar:
 * la fecha está en la fila). Con NEEDS_HUMAN_AFTER_ATTEMPTS fallos sale en
 * Incidencias con el motivo.
 */
@Injectable()
export class RefundReversalSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RefundReversalSweepService.name);
  private readonly prisma: PrismaService;
  private readonly payments: PaymentsService;
  private readonly metrics: MetricsService;
  private readonly audit: AuditService;
  private bootTimer: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private removeMetrics?: () => void;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(PaymentsService) payments: PaymentsService,
    @Inject(MetricsService) metrics: MetricsService,
    @Inject(AuditService) audit: AuditService,
  ) {
    this.prisma = prisma;
    this.payments = payments;
    this.metrics = metrics;
    this.audit = audit;
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

  /** Lo pendiente de verdad: también lo diferido, con su edad desde la devolución (reintentar no la rejuvenece). */
  async backlog(): Promise<ReversalBacklog> {
    const rows = await this.prisma.asSystem((tx) =>
      tx.$queryRaw<Array<{ pending: bigint; oldestAgeSeconds: number | null; needsHuman: bigint }>>`
        SELECT COUNT(*)::bigint AS pending,
               EXTRACT(EPOCH FROM (NOW() - MIN(r."createdAt")))::float8 AS "oldestAgeSeconds",
               COUNT(*) FILTER (WHERE r."earningReversalAttempts" >= ${NEEDS_HUMAN_AFTER_ATTEMPTS})::bigint AS "needsHuman"
          FROM refunds r
         WHERE r.status = 'SUCCEEDED'
           AND EXISTS (SELECT 1 FROM operator_earnings e WHERE e."paymentId" = r."paymentId")
           AND NOT EXISTS (SELECT 1 FROM earning_reversals er WHERE er."refundId" = r.id)
      `,
    );
    const row = rows[0];
    return {
      pending: Number(row?.pending ?? 0),
      oldestAgeSeconds: Math.max(0, row?.oldestAgeSeconds ?? 0),
      needsHuman: Number(row?.needsHuman ?? 0),
    };
  }

  async sweep(now: Date = new Date()): Promise<{ checked: number; applied: number; failed: number }> {
    const missing = await this.findMissing(now);
    let applied = 0;
    for (const m of missing) {
      const failure = await this.redrive(m);
      if (failure === null) applied += 1;
      else await this.deferRetry(m, failure, now);
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
   * Las que tocan ya (sin intento fallido, o con su siguiente intento
   * vencido), la que más espera primero. Cruza locales a propósito (tarea del
   * sistema): con el bypass del RLS, que en operator_earnings /
   * earning_reversals es forzado.
   */
  private async findMissing(now: Date): Promise<MissingReversal[]> {
    const before = new Date(now.getTime() - GRACE_MS);
    return this.prisma.asSystem((tx) =>
      tx.$queryRaw<MissingReversal[]>`
        SELECT r.id AS "refundId", r."paymentId", r."tenantId", r."amountCents",
               r."earningReversalAttempts" AS attempts
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

  /** null si el descuento quedó apuntado (hay fila en earning_reversals); si no, el motivo. */
  private async redrive(m: MissingReversal): Promise<string | null> {
    let why: string;
    try {
      await this.payments.applyRefundToEarning(m.paymentId, m.refundId, m.amountCents);
      if (await this.reversalExists(m.refundId)) return null;
      why = 'applyRefundToEarning no dejó registro (¿no ve el earning?)';
    } catch (err) {
      why = err instanceof Error ? err.message : String(err);
    }
    this.metrics.earningReversalFailed.inc({ venue: m.tenantId });
    this.logger.error(
      `Repaso: la devolución ${m.refundId} (cobro ${m.paymentId}, ${m.amountCents}c) sigue sin descontarse a la chica: ${why}`,
    );
    return why;
  }

  private async reversalExists(refundId: string): Promise<boolean> {
    const rows = await this.prisma.asSystem((tx) =>
      tx.$queryRaw<unknown[]>`SELECT 1 AS ok FROM earning_reversals WHERE "refundId" = ${refundId}::uuid`,
    );
    return rows.length > 0;
  }

  /**
   * Siguiente intento más tarde y el motivo guardado. Solo si nadie (otra
   * réplica) contó ya este intento: el aviso sale una sola vez.
   */
  private async deferRetry(m: MissingReversal, why: string, now: Date): Promise<void> {
    const attempts = m.attempts + 1;
    const done = await this.prisma.asSystem((tx) =>
      tx.refund.updateMany({
        where: { id: m.refundId, status: 'SUCCEEDED', earningReversalAttempts: m.attempts },
        data: {
          earningReversalAttempts: attempts,
          earningReversalRetryAt: new Date(now.getTime() + nextRetryDelayMs(attempts)),
          earningReversalLastError: why.slice(0, MAX_ERROR_LENGTH),
        },
      }),
    );
    if (done.count === 1 && attempts === NEEDS_HUMAN_AFTER_ATTEMPTS) await this.escalate(m, why, attempts);
  }

  /** A Incidencias, con el motivo: el repaso no lo arregla solo. Un fallo aquí no para el repaso. */
  private async escalate(m: MissingReversal, why: string, attempts: number): Promise<void> {
    try {
      await this.audit.log({
        action: 'refund.earning_reverse_failed',
        tenantId: m.tenantId,
        actorId: null,
        targetType: 'Payment',
        targetId: m.paymentId,
        payload: {
          refundId: m.refundId,
          amountCents: m.amountCents,
          error: why.slice(0, MAX_ERROR_LENGTH),
          attempts,
          source: 'sweep',
          needsHuman: true,
        },
      });
    } catch (err) {
      this.logger.error(`No se pudo avisar en Incidencias de la devolución ${m.refundId}: ${(err as Error).message}`);
    }
  }
}
