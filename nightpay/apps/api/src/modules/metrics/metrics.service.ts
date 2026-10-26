import { Injectable, OnModuleInit } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { QueueGauges, type QueueSource } from './queue-gauges';
import { SCRAPE_TIMEOUT_MS, withTimeout } from './scrape-timeout';

/** Lo que da el repaso de devoluciones sin descontar a la chica. */
export interface ReversalBacklog {
  pending: number;
  oldestAgeSeconds: number;
  needsHuman: number;
}

/**
 * MetricsService — Prometheus exporter (text format /metrics).
 * Counters/Gauges/Histograms expuestos para que los modulos los actualicen.
 *
 * Convencion de nombres: nightpay_<dominio>_<cosa>_<unidad>
 */
@Injectable()
export class MetricsService implements OnModuleInit {
  readonly registry = new Registry();

  // ─── Counters de negocio ──────────────────────────────────────────
  readonly paymentsCreated = new Counter({
    name: 'nightpay_payments_created_total',
    help: 'Pagos creados por venue + provider',
    labelNames: ['venue', 'provider'],
    registers: [this.registry],
  });
  readonly paymentsTransitioned = new Counter({
    name: 'nightpay_payments_transitioned_total',
    help: 'Transiciones FSM de pagos',
    labelNames: ['from', 'to'],
    registers: [this.registry],
  });
  readonly refundsCreated = new Counter({
    name: 'nightpay_refunds_created_total',
    help: 'Refunds emitidos',
    labelNames: ['venue', 'provider', 'status'],
    registers: [this.registry],
  });

  // Earning reverse fallido tras refund OK del cliente. Debe estar SIEMPRE en 0;
  // valor >0 indica discrepancia financiera (chica cobra de más). Alertar siempre.
  // Dos intentos del mismo cobro aprobados por el banco: el cliente pagó dos
  // veces. Hay que devolver uno (el aviso queda en payment_events).
  readonly duplicateCharges = new Counter({
    name: 'nightpay_duplicate_charges_total',
    help: 'Cobros con más de un intento aprobado por el banco (devolver uno)',
    labelNames: ['venue', 'provider'],
    registers: [this.registry],
  });

  private readonly earningReversalFailedCounter = new Counter({
    name: 'nightpay_earning_reversal_failed_total',
    help: 'Earning reverse silenciado (refund OK pero comisión chica no descontada)',
    labelNames: ['venue'],
    registers: [this.registry],
  });
  /**
   * Solo por local. El id del cobro era etiqueta: una serie nueva por cobro
   * (cardinalidad sin límite). El id va en el log y en audit_events
   * ('refund.earning_reverse_failed'); si alguien aún lo pasa, se ignora.
   */
  readonly earningReversalFailed = {
    inc: (labels: { venue: string; payment_id?: string }, value = 1): void => {
      this.earningReversalFailedCounter.inc({ venue: labels.venue }, value);
    },
  };
  // Lo que falta por descontar a las chicas por devoluciones ya hechas (lo
  // lee el repaso, refund-reversal-sweep): cuántas, la más antigua desde la
  // devolución (un reintento diferido no la rejuvenece) y las que ya necesitan
  // a una persona. Sin consulta en este scrape, sin muestras y _up a 0.
  readonly earningReversalPending = new Gauge({
    name: 'nightpay_earning_reversal_pending',
    help: 'Devoluciones hechas pendientes de descontar la ganancia, incluidos reintentos diferidos',
    registers: [this.registry],
  });
  readonly earningReversalOldestAge = new Gauge({
    name: 'nightpay_earning_reversal_oldest_age_seconds',
    help: 'Segundos desde la devolución de la más antigua sin descontar (0 si no hay)',
    registers: [this.registry],
  });
  readonly earningReversalNeedsHuman = new Gauge({
    name: 'nightpay_earning_reversal_needs_human',
    help: 'Devoluciones sin descontar que el repaso no consigue arreglar (salen en Incidencias con su motivo)',
    registers: [this.registry],
  });
  readonly earningReversalMetricsUp = new Gauge({
    name: 'nightpay_earning_reversal_metrics_up',
    help: '1 si se pudo consultar el backlog de reversiones en este scrape',
    registers: [this.registry],
  });
  private reversalSource?: () => Promise<ReversalBacklog>;

  /** Quién da el backlog (el repaso de devoluciones). Devuelve cómo quitarlo al parar. */
  observeEarningReversals(source: () => Promise<ReversalBacklog>): () => void {
    this.reversalSource = source;
    return () => {
      if (this.reversalSource === source) this.reversalSource = undefined;
    };
  }

  private async collectEarningReversals(): Promise<void> {
    const source = this.reversalSource;
    if (!source) return;
    try {
      const data = await withTimeout(source(), SCRAPE_TIMEOUT_MS, 'Reversal metrics timeout');
      if (this.reversalSource !== source) return;
      this.earningReversalPending.set(data.pending);
      this.earningReversalOldestAge.set(data.oldestAgeSeconds);
      this.earningReversalNeedsHuman.set(data.needsHuman);
      this.earningReversalMetricsUp.set(1);
    } catch {
      // remove(), no reset(): un gauge sin etiquetas vuelve a 0 con reset() y
      // 0 diría «nada pendiente». Sin muestra, la alerta mira _up.
      this.earningReversalPending.remove();
      this.earningReversalOldestAge.remove();
      this.earningReversalNeedsHuman.remove();
      this.earningReversalMetricsUp.set(0);
    }
  }

  // Wallet top-up AUTHORIZED pero credit no aplicado (wallet status != ACTIVE).
  // También crítico — el cliente fue cargado y el wallet no recibió el saldo.
  readonly walletCreditSkipped = new Counter({
    name: 'nightpay_wallet_credit_skipped_total',
    help: 'Wallet top-up AUTHORIZED sin credit (status wallet incorrecto)',
    labelNames: ['venue', 'wallet_status'],
    registers: [this.registry],
  });

  // ─── Auth ─────────────────────────────────────────────────────────
  readonly authLogins = new Counter({
    name: 'nightpay_auth_logins_total',
    help: 'Intentos de login',
    labelNames: ['outcome'], // ok|failed|locked
    registers: [this.registry],
  });

  // ─── Webhooks ─────────────────────────────────────────────────────
  readonly webhooksReceived = new Counter({
    name: 'nightpay_webhooks_received_total',
    help: 'Webhooks recibidos',
    labelNames: ['provider', 'outcome'], // valid|invalid|duplicate
    registers: [this.registry],
  });

  // ─── Gateway calls (latencias) ────────────────────────────────────
  readonly gatewayDuration = new Histogram({
    name: 'nightpay_gateway_call_duration_seconds',
    help: 'Latencia de llamadas a pasarelas',
    labelNames: ['provider', 'op', 'outcome'],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    registers: [this.registry],
  });
  readonly circuitState = new Gauge({
    name: 'nightpay_circuit_state',
    help: 'Estado del circuit breaker (0=closed, 1=half-open, 2=open)',
    labelNames: ['provider', 'op'],
    registers: [this.registry],
  });

  // ─── Aislamiento por local ────────────────────────────────────────
  // Consultas a un modelo por local sin local ni asSystem/acrossVenues (ver
  // PrismaService). Debe estar en 0: si sube, hay un camino sin aislamiento.
  readonly tenantUnscopedQueries = new Counter({
    name: 'nightpay_tenant_unscoped_queries_total',
    help: 'Consultas a modelos por local sin local en el contexto ni asSystem/acrossVenues',
    labelNames: ['model', 'action'],
    registers: [this.registry],
  });

  // Consultas a una tabla con FORCE RLS (saldos, consumos, comisiones, pagos
  // a chicas, Peanpe) fuera de una transacción de PrismaService: con un rol de
  // base de datos sin superusuario no ven filas. Debe estar en 0.
  readonly rlsOutsideTransaction = new Counter({
    name: 'nightpay_rls_outside_transaction_total',
    help: 'Consultas a tablas con FORCE RLS fuera de withTenant/asSystem/acrossVenues/$transaction',
    labelNames: ['target', 'action'],
    registers: [this.registry],
  });

  // 1 si el rol con el que entra el API es superusuario o tiene BYPASSRLS: las
  // políticas RLS no actúan (PrismaService.checkDatabaseRole, al arrancar).
  readonly dbRoleBypassesRls = new Gauge({
    name: 'nightpay_db_role_bypasses_rls',
    help: '1 si el rol de la base de datos del API se salta RLS (superusuario o BYPASSRLS)',
    registers: [this.registry],
  });

  // 429 del límite global de peticiones (main.ts): por qué tope saltó (ip =
  // anónimos de una IP, user = una persona, venue = un local entero).
  readonly rateLimited = new Counter({
    name: 'nightpay_rate_limited_total',
    help: 'Peticiones cortadas con 429 por el límite global',
    labelNames: ['limiter', 'kind'],
    registers: [this.registry],
  });

  // ─── WS / queues ──────────────────────────────────────────────────
  readonly wsConnectionsActive = new Gauge({
    name: 'nightpay_ws_connections_active',
    help: 'Conexiones Socket.io activas',
    registers: [this.registry],
  });
  // payment:subscribe sin sesión del personal (apps antiguas). Tiene que
  // llegar a 0 antes de REALTIME_LEGACY_SUBSCRIBE_UNTIL; después solo sube
  // "closed" (se rechaza y se pide iniciar sesión).
  readonly wsLegacySubscribes = new Counter({
    name: 'nightpay_ws_legacy_subscribes_total',
    help: 'payment:subscribe sin sesión del personal (apps antiguas)',
    labelNames: ['result'], // allowed|denied|closed
    registers: [this.registry],
  });
  // Sesión del personal con el refresh token en el cuerpo (apps antiguas,
  // client="legacy"; o la app nueva pasándolo a la cookie, "migration").
  // Tiene que quedarse quieta antes de AUTH_BODY_REFRESH_UNTIL; después solo
  // sube result="closed".
  readonly authBodyRefresh = new Counter({
    name: 'nightpay_auth_body_refresh_total',
    help: 'Refresh token en el cuerpo de login/refresh/logout (apps antiguas)',
    labelNames: ['route', 'client', 'result'], // login|refresh|logout · legacy|migration · allowed|closed
    registers: [this.registry],
  });
  // Colas de BullMQ, leídas en cada scrape (queue-gauges.ts; las registra QueueMetricsService).
  private readonly queues = new QueueGauges(this.registry);
  readonly queueDepth = this.queues.depth;
  readonly queueJobs = this.queues.jobs;
  readonly queueOldestAge = this.queues.oldestAge;
  readonly queueMetricsUp = this.queues.up;
  private collection?: Promise<void>;

  /** BullMQ es dueño de las conexiones; quien registra las colas las quita antes de cerrarlas. */
  observeQueues(queues: readonly QueueSource[]): () => void {
    return this.queues.observe(queues);
  }

  onModuleInit(): void {
    // Default metrics: process_cpu_seconds, process_memory_bytes, nodejs_eventloop_lag, etc.
    collectDefaultMetrics({ register: this.registry, prefix: 'nightpay_' });
  }

  /**
   * Devuelve el dump en formato Prometheus text, con las colas y el backlog de
   * descuentos leídos ahora (dos scrapes a la vez comparten la misma lectura).
   */
  async render(): Promise<string> {
    this.collection ??= Promise.all([this.queues.collect(), this.collectEarningReversals()]).then(() => undefined);
    try {
      await this.collection;
    } finally {
      this.collection = undefined;
    }
    return this.registry.metrics();
  }
}
