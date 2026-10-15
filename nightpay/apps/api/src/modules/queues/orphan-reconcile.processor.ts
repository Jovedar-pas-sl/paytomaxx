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
}

/** Cobros en los que aún puede faltar apuntar una aprobación del banco. */
const RECONCILABLE = new Set(['AUTHORIZING', 'ORPHAN', 'FAILED']);

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

    const payment: ReconcilablePayment = await this.payments.findById(paymentId);
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
    const approved = await this.approvedOrders(adapter, tenantId, orders);
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
