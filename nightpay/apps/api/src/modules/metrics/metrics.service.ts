import { Injectable, OnModuleInit } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { Queue } from 'bullmq';

const PENDING_STATES = ['waiting', 'active', 'delayed', 'prioritized', 'waiting-children', 'paused'] as const;
// BullMQ keeps creation timestamp across retries/promotions. Availability cannot
// be reconstructed from timestamp + delay: delay is relative to the retry time.
const AGE_STATES = ['waiting', 'active', 'prioritized', 'paused'] as const;
const QUEUE_STATES = [...PENDING_STATES, 'failed', 'completed'] as const;
type QueueSource = Pick<Queue, 'name' | 'getJobCounts'> & {
  getJobs: (...args: Parameters<Queue['getJobs']>) => Promise<Array<{ timestamp: number; delay?: number } | undefined>>;
};

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
  readonly earningReversalPending = new Gauge({ name: 'nightpay_earning_reversal_pending', help: 'Devoluciones hechas pendientes de descontar la ganancia, incluidos reintentos diferidos', registers: [this.registry] });
  readonly earningReversalOldestAge = new Gauge({ name: 'nightpay_earning_reversal_oldest_age_seconds', help: 'Antigüedad desde la devolución original de la reversión pendiente más antigua', registers: [this.registry] });
  readonly earningReversalMetricsUp = new Gauge({ name: 'nightpay_earning_reversal_metrics_up', help: '1 si se pudo consultar el backlog de reversiones en este scrape', registers: [this.registry] });
  private reversalSource?: () => Promise<{ pending: number; oldestAgeSeconds: number }>;

  observeEarningReversals(source: () => Promise<{ pending: number; oldestAgeSeconds: number }>): () => void {
    this.reversalSource = source;
    return () => { if (this.reversalSource === source) this.reversalSource = undefined; };
  }

  private async collectEarningReversals(): Promise<void> {
    const source = this.reversalSource;
    if (!source) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const data = await Promise.race([
        source(), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Reversal metrics timeout')), 2000); }),
      ]);
      if (this.reversalSource !== source) return;
      this.earningReversalPending.set(data.pending);
      this.earningReversalOldestAge.set(data.oldestAgeSeconds);
      this.earningReversalMetricsUp.set(1);
    } catch {
      this.earningReversalPending.remove();
      this.earningReversalOldestAge.remove();
      this.earningReversalMetricsUp.set(0);
    } finally { if (timeout) clearTimeout(timeout); }
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
  readonly queueDepth = new Gauge({
    name: 'nightpay_queue_depth',
    help: 'Trabajos sin terminar en BullMQ (waiting, active, delayed, prioritized, waiting-children, paused)',
    labelNames: ['queue'],
    registers: [this.registry],
  });
  readonly queueJobs = new Gauge({
    name: 'nightpay_queue_jobs', help: 'Trabajos BullMQ por estado',
    labelNames: ['queue', 'state'], registers: [this.registry],
  });
  readonly queueOldestAge = new Gauge({
    name: 'nightpay_queue_oldest_age_seconds', help: 'Edad desde creación del trabajo más antiguo en waiting/active/prioritized/paused; excluye delayed y waiting-children',
    labelNames: ['queue'], registers: [this.registry],
  });
  readonly queueMetricsUp = new Gauge({
    name: 'nightpay_queue_metrics_up', help: '1 si se pudo consultar BullMQ en este scrape, 0 si falló',
    labelNames: ['queue'], registers: [this.registry],
  });
  private readonly queueSources = new Set<QueueSource>();
  private queueCollection?: Promise<void>;

  /** BullMQ owns connections; the registering module removes sources before shutdown. */
  observeQueues(queues: readonly QueueSource[]): () => void {
    queues.forEach((queue) => this.queueSources.add(queue));
    return () => queues.forEach((queue) => {
      this.queueSources.delete(queue);
      this.clearQueue(queue.name);
      this.queueMetricsUp.remove({ queue: queue.name });
    });
  }

  private clearQueue(queue: string): void {
    this.queueDepth.remove({ queue });
    this.queueOldestAge.remove({ queue });
    QUEUE_STATES.forEach((state) => this.queueJobs.remove({ queue, state }));
  }

  private async oldestQueueAge(queue: QueueSource, deadline: number): Promise<number> {
    let oldest = 0;
    // getJobs applies pagination to each state. Read every page rather than
    // assuming priority order or retry order implies oldest creation time.
    for (let start = 0; ; start += 500) {
      if (!this.queueSources.has(queue)) return 0;
      if (Date.now() >= deadline) throw new Error('BullMQ metrics timeout');
      const jobs = await queue.getJobs([...AGE_STATES], start, start + 499);
      const now = Date.now();
      oldest = jobs.reduce((age, job) => job ? Math.max(age, (now - job.timestamp) / 1000) : age, oldest);
      if (jobs.length < 500) return oldest;
    }
  }

  private async collectQueue(queue: QueueSource): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const [counts, age] = await Promise.race([
        Promise.all([
          queue.getJobCounts(...QUEUE_STATES),
          this.oldestQueueAge(queue, Date.now() + 2000),
        ]),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('BullMQ metrics timeout')), 2000); }),
      ]);
      if (!this.queueSources.has(queue)) return;
      const labels = { queue: queue.name };
      QUEUE_STATES.forEach((state) => this.queueJobs.set({ ...labels, state }, counts[state] ?? 0));
      this.queueDepth.set(labels, PENDING_STATES.reduce((sum, state) => sum + (counts[state] ?? 0), 0));
      this.queueOldestAge.set(labels, age);
      this.queueMetricsUp.set(labels, 1);
    } catch {
      if (!this.queueSources.has(queue)) return;
      this.clearQueue(queue.name);
      this.queueMetricsUp.set({ queue: queue.name }, 0);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  onModuleInit(): void {
    // Default metrics: process_cpu_seconds, process_memory_bytes, nodejs_eventloop_lag, etc.
    collectDefaultMetrics({ register: this.registry, prefix: 'nightpay_' });
  }

  /** Devuelve el dump en formato Prometheus text. */
  async render(): Promise<string> {
    this.queueCollection ??= Promise.all([...this.queueSources].map((queue) => this.collectQueue(queue)).concat(this.collectEarningReversals())).then(() => undefined);
    try {
      await this.queueCollection;
    } finally {
      this.queueCollection = undefined;
    }
    return this.registry.metrics();
  }
}
