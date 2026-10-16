import { Injectable, OnModuleInit } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

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
  readonly queueDepth = new Gauge({
    name: 'nightpay_queue_depth',
    help: 'Tamaño actual de cada cola BullMQ',
    labelNames: ['queue'],
    registers: [this.registry],
  });

  onModuleInit(): void {
    // Default metrics: process_cpu_seconds, process_memory_bytes, nodejs_eventloop_lag, etc.
    collectDefaultMetrics({ register: this.registry, prefix: 'nightpay_' });
  }

  /** Devuelve el dump en formato Prometheus text. */
  async render(): Promise<string> {
    return this.registry.metrics();
  }
}
