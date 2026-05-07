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

  // ─── WS / queues ──────────────────────────────────────────────────
  readonly wsConnectionsActive = new Gauge({
    name: 'nightpay_ws_connections_active',
    help: 'Conexiones Socket.io activas',
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
