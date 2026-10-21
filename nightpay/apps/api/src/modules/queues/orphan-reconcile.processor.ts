import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import type { GatewayStatus, Provider } from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';
import { GatewayRegistry } from '../gateways/gateway.registry';
import type { GatewayAdapter } from '../gateways/gateway.adapter';
import { ORPHAN_RECONCILE_QUEUE } from './queue-tokens';
import { InvalidTransitionError } from '../payments/payment.machine';
import { AMOUNT_MISMATCH_EVENT } from './approval-check';
import { lateApprovalHandled, settleLateCardApproval, wasPaidWithSaldo } from '../payments/late-card-approval';

interface OrphanReconcileJobData {
  paymentId: string;
  tenantId: string;
}

interface ReconcilablePayment {
  id: string;
  tenantId: string;
  status: string;
  provider: Provider | null;
  providerTxId: string | null;
  amountCents: number;
}

/** Cobros en los que aún puede faltar apuntar una aprobación del banco. */
const RECONCILABLE = new Set(['AUTHORIZING', 'ORPHAN', 'FAILED']);

/** Pedido de una incidencia de importe (webhook-ingest lo guarda como providerTxId). */
function orderOf(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const v = (payload as Record<string, unknown>).providerTxId;
  return typeof v === 'string' ? v : null;
}

/**
 * Pedidos a consultar en la pasarela, uno por intento (payment_attempts):
 * primero los no denegados, del más reciente al más antiguo, y después los
 * denegados (Redsys deja reintentar en su página con el mismo pedido: un
 * DENIED puede haberse pagado luego y su aviso perderse). Sin intentos
 * (cobros anteriores a la Fase 0): el pedido del cobro.
 */
export function ordersToReconcile(
  attempts: ReadonlyArray<{ providerTxId: string; status: string }>,
  fallbackOrder: string | null,
): string[] {
  if (attempts.length === 0) return fallbackOrder ? [fallbackOrder] : [];
  const open = attempts.filter((a) => a.status !== 'DENIED');
  const denied = attempts.filter((a) => a.status === 'DENIED');
  return [...new Set([...open, ...denied].map((a) => a.providerTxId))];
}

/**
 * Saga de compensación: cuando un pago lleva tiempo en AUTHORIZING sin webhook,
 * consultamos a la pasarela el estado real de CADA intento y resolvemos.
 *
 *  - Algún intento aprobado → AUTHORIZED con ese pedido (su propina, como el
 *    aviso del banco). Dos aprobados = doble cobro: queda la incidencia.
 *  - Ninguno aprobado → NUNCA FAILED por lo que diga la pasarela: una
 *    denegación de un pedido no prueba que no se pagara otro (ni ese mismo,
 *    reintentando). Se reintenta con backoff y, agotados los reintentos, el
 *    cobro pasa a ORPHAN: sale en Incidencias y se resuelve a mano con el
 *    portal del banco (Pagos → Resolver).
 *  - Un cobro ya FAILED solo se revisa una vez (por si el banco lo aprobó).
 */
@Processor(ORPHAN_RECONCILE_QUEUE)
export class OrphanReconcileProcessor extends WorkerHost {
  private readonly logger = new Logger(OrphanReconcileProcessor.name);
  private readonly prisma: PrismaService;
  private readonly payments: PaymentsService;
  private readonly gateways: GatewayRegistry;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(PaymentsService) payments: PaymentsService,
    @Inject(GatewayRegistry) gateways: GatewayRegistry,
  ) {
    super();
    this.prisma = prisma;
    this.payments = payments;
    this.gateways = gateways;
  }

  async process(job: Job<OrphanReconcileJobData>): Promise<void> {
    const { paymentId, tenantId } = job.data;
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;

    // Sin petición no hay local en el contexto: lectura de sistema (si no, cuenta
    // como consulta sin local y con TENANCY_UNSCOPED_QUERIES=throw se cortaría).
    const payment: ReconcilablePayment = await this.prisma.asSystem(() => this.payments.findById(paymentId));
    // Cobro único: lo pagó el saldo con la tarjeta en el banco. Si el banco la
    // aprobó sin avisar (aviso perdido), se trata como el aviso tardío.
    if (payment.status === 'CANCELED' && payment.provider && (await wasPaidWithSaldo(this.prisma, payment.id))) {
      await this.reconcileAfterSaldo(payment, payment.provider, attempt < maxAttempts);
      return;
    }
    if (!RECONCILABLE.has(payment.status)) {
      this.logger.debug(`Orphan ${paymentId} ya resuelto (${payment.status}) — nada que conciliar`);
      return;
    }

    const orders = payment.provider ? await this.ordersOf(payment) : [];
    if (!payment.provider || orders.length === 0) {
      // Nunca llegó a abrirse un pedido en la pasarela: no hay nada cobrado.
      await this.failWithoutOrder(payment);
      return;
    }

    const adapter = this.gateways.get(payment.provider);
    const approved = await this.withoutAmountMismatch(
      payment.id,
      await this.approvedOrders(adapter, tenantId, orders),
    );
    if (approved.length > 0) {
      await this.book(payment, payment.provider, approved);
      return;
    }

    if (payment.status === 'FAILED') {
      this.logger.debug(`Orphan ${paymentId} FAILED y sin aprobación en la pasarela — se deja como está`);
      return;
    }
    if (attempt < maxAttempts) {
      this.logger.warn(
        `Orphan ${paymentId} sin aprobación confirmada (${orders.length} pedidos) — retry ${attempt}/${maxAttempts}`,
      );
      throw new Error('still-pending');
    }
    await this.park(payment);
  }

  /**
   * Cobro único pagado con el saldo mientras la tarjeta estaba en el banco:
   * cada pedido aprobado (y aún no tratado) se devuelve solo o queda en
   * Incidencias. Sin aprobación, se vuelve a mirar mientras queden reintentos.
   */
  private async reconcileAfterSaldo(payment: ReconcilablePayment, provider: Provider, retry: boolean): Promise<void> {
    const orders = await this.ordersOf(payment);
    if (orders.length === 0) return;
    const adapter = this.gateways.get(provider);
    const approved = await this.approvedOrders(adapter, payment.tenantId, orders);
    for (const order of approved) {
      if (await lateApprovalHandled(this.prisma, payment.id, order)) continue;
      const outcome = await settleLateCardApproval({ prisma: this.prisma, adapter, logger: this.logger }, payment, order);
      await this.prisma.asSystem((tx) =>
        tx.paymentEvent.create({
          data: {
            paymentId: payment.id,
            tenantId: payment.tenantId,
            eventType: outcome.eventType,
            payload: { ...outcome.payload, source: 'conciliacion' } as never,
            traceId: randomUUID(),
          },
        }),
      );
    }
    if (approved.length === 0 && retry) throw new Error('still-pending');
  }

  private async ordersOf(payment: ReconcilablePayment): Promise<string[]> {
    const attempts = await this.prisma.asSystem((tx) =>
      tx.paymentAttempt.findMany({
        where: { paymentId: payment.id, provider: payment.provider ?? undefined },
        orderBy: { createdAt: 'desc' },
        select: { providerTxId: true, status: true },
      }),
    );
    return ordersToReconcile(attempts, payment.providerTxId);
  }

  /** Estado de cada pedido; un fallo de red cuenta como "no se sabe". */
  private async approvedOrders(
    adapter: GatewayAdapter,
    tenantId: string,
    orders: string[],
  ): Promise<string[]> {
    const approved: string[] = [];
    for (const order of orders) {
      if ((await this.safeStatus(adapter, tenantId, order)) === 'AUTHORIZED') approved.push(order);
    }
    return approved;
  }

  /**
   * La consulta a la pasarela solo dice "aprobado", no el importe. Un pedido
   * cuyo aviso ya se rechazó porque el banco cobró otro importe no se da por
   * pagado así: sigue en su incidencia (y el cobro, si no hay otro pedido, en
   * ORPHAN para resolverlo a mano con el portal del banco).
   */
  private async withoutAmountMismatch(paymentId: string, approved: string[]): Promise<string[]> {
    if (approved.length === 0) return approved;
    const flagged = await this.prisma.asSystem((tx) =>
      tx.paymentEvent.findMany({
        where: { paymentId, eventType: AMOUNT_MISMATCH_EVENT },
        select: { payload: true },
      }),
    );
    const blocked = new Set(flagged.map((e) => orderOf(e.payload)).filter((o): o is string => o !== null));
    const bookable = approved.filter((o) => !blocked.has(o));
    if (bookable.length < approved.length) {
      this.logger.warn(
        `Orphan ${paymentId}: pedidos aprobados con importe distinto (${approved.filter((o) => blocked.has(o)).join(', ')}) — no se dan por pagados`,
      );
    }
    return bookable;
  }

  private async safeStatus(adapter: GatewayAdapter, tenantId: string, order: string): Promise<GatewayStatus> {
    try {
      return await adapter.getStatus(tenantId, order);
    } catch (err) {
      this.logger.warn(`Orphan: consulta de ${order} en ${adapter.provider} falló: ${(err as Error).message}`);
      return 'UNKNOWN';
    }
  }

  /**
   * Apunta el cobro con el pedido aprobado (como el aviso del banco: marca el
   * intento APPROVED y transition() fija la propina de ese intento).
   */
  private async book(payment: ReconcilablePayment, provider: Provider, approved: string[]): Promise<void> {
    const [chosen, ...extra] = approved as [string, ...string[]];
    await this.prisma.asSystem(async (tx) => {
      await tx.paymentAttempt.updateMany({
        where: { paymentId: payment.id, provider, providerTxId: { in: approved }, status: { not: 'APPROVED' } },
        data: { status: 'APPROVED' },
      });
      for (const order of extra) {
        const already = await tx.paymentEvent.count({
          where: { paymentId: payment.id, eventType: 'payment.duplicate_charge', payload: { path: ['order'], equals: order } },
        });
        if (already > 0) continue;
        this.logger.error(`DOBLE COBRO payment=${payment.id}: el pedido ${order} también está aprobado. Devolver uno.`);
        await tx.paymentEvent.create({
          data: {
            paymentId: payment.id,
            tenantId: payment.tenantId,
            eventType: 'payment.duplicate_charge',
            payload: { order, source: 'conciliacion' },
            traceId: randomUUID(),
          },
        });
      }
    });
    try {
      await this.payments.transition(payment.id, { type: 'AUTHORIZED', provider, providerTxId: chosen });
      this.logger.log(`Orphan resolved → AUTHORIZED: ${payment.id} (pedido ${chosen})`);
    } catch (err) {
      if (!(err instanceof InvalidTransitionError)) throw err;
      // Carrera con el aviso del banco, que ya lo apuntó.
      this.logger.debug(`Orphan ${payment.id} ya transicionó (${err.fromState}) — race con webhook`);
    }
  }

  /** Reintentos agotados sin confirmar nada: ORPHAN, para resolverlo a mano. */
  private async park(payment: ReconcilablePayment): Promise<void> {
    if (payment.status !== 'AUTHORIZING') return; // ORPHAN ya está aparcado
    this.logger.warn(`Orphan ${payment.id} reintentos agotados — ORPHAN para reconciliación manual`);
    try {
      await this.payments.transition(payment.id, { type: 'TIMEOUT' });
    } catch (err) {
      if (!(err instanceof InvalidTransitionError)) throw err;
      this.logger.debug(`Orphan ${payment.id} ya transicionó — race con webhook`);
    }
  }

  private async failWithoutOrder(payment: ReconcilablePayment): Promise<void> {
    if (payment.status === 'FAILED') return;
    this.logger.warn(`Orphan ${payment.id} has no providerTxId — marking FAILED`);
    try {
      await this.payments.transition(payment.id, { type: 'FAILED', reason: 'orphan-without-provider-tx' });
    } catch (err) {
      if (!(err instanceof InvalidTransitionError)) throw err;
    }
  }
}
