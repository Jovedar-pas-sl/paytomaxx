# Observability — NightPay

## Stack

| Capa | Producto | Notas |
|---|---|---|
| **Errors** | Sentry | Captura excepciones unhandled + HTTP 5xx. Configurable vía `SENTRY_DSN` env var. |
| **Metrics** | Prometheus + Grafana | `/v1/metrics` expone formato text. Dashboard JSON en `nightpay.dashboard.json`. |
| **Logs** | Pino → stdout | Por defecto a stdout estructurado JSON; en prod recoger con Loki/CloudWatch/etc. |
| **Tracing** | Sentry traces (10% sampling) | Phase 2: OpenTelemetry full traces. |
| **Alerts** | Prometheus Alertmanager | Reglas en `alerts.yml`. |

Las incidencias dentro de NightPay y sus avisos por Telegram conservan su
funcionamiento. Estas reglas son para quien ya use Prometheus; no requieren
instalar otra plataforma para operar la aplicación.

## Setup local

```bash
# Prometheus + Grafana via docker-compose (no incluido en docker-compose.yml principal
# porque solo se necesita en debug)
docker run -d --name nightpay_prom -p 9090:9090 \
  -v $(pwd)/nightpay/docs/observability/prometheus.yml:/etc/prometheus/prometheus.yml \
  -v $(pwd)/nightpay/docs/observability/alerts.yml:/etc/prometheus/alerts.yml \
  prom/prometheus

docker run -d --name nightpay_grafana -p 3000:3000 grafana/grafana
# admin / admin
# Datasource: Prometheus → http://host.docker.internal:9090
# Import dashboard JSON: nightpay.dashboard.json
```

## Setup Sentry

1. Crear proyecto Sentry tipo "Node.js"
2. Copiar DSN al `.env.local`:
   ```bash
   SENTRY_DSN=https://abc123@o0.ingest.sentry.io/0
   GIT_SHA=$(git rev-parse HEAD)  # opcional, para releases
   ```
3. Reiniciar API. Verás `[observability] Sentry initialized` en logs.

Sin `SENTRY_DSN` el SDK no se inicializa (no-op). Apto para dev.

## Métricas principales

| Métrica | Tipo | Para qué |
|---|---|---|
| `nightpay_payments_created_total` | Counter | Volumen de cobros por venue/provider |
| `nightpay_payments_transitioned_total` | Counter | Transiciones FSM — detectar pagos atascados |
| `nightpay_refunds_created_total` | Counter | Refunds — anomalía si pico súbito |
| `nightpay_auth_logins_total` | Counter | Brute-force detection (outcome=failed) |
| `nightpay_webhooks_received_total` | Counter | PSP health (outcome=invalid alerta) |
| `nightpay_gateway_call_duration_seconds` | Histogram | Latencia pasarela — p99 para SLO |
| `nightpay_circuit_state` | Gauge | Circuit breaker estado por gateway |
| `nightpay_ws_connections_active` | Gauge | Conexiones realtime |
| `nightpay_queue_depth` | Gauge | Trabajos sin terminar por cola: waiting + active + delayed + prioritized + waiting-children + paused |
| `nightpay_queue_jobs` | Gauge | Cantidad real por cola y estado; completed/failed se exponen aparte del backlog |
| `nightpay_queue_oldest_age_seconds` | Gauge | Edad máxima desde creación en waiting/active/prioritized/paused; excluye delayed y waiting-children |
| `nightpay_queue_metrics_up` | Gauge | 1 si se consultó Redis en este scrape, 0 si falló o excedió 2 s |

El scrape consulta las cinco colas registradas de BullMQ, incluida la cola de
conciliación retirada para detectar residuos. No crea conexiones ni temporizadores
de sondeo; BullMQ conserva su ciclo de vida. Las consultas de antigüedad se paginan.
Ante fallo se omiten depth/age/jobs de esa cola, para no presentar un valor antiguo
como actual; otras métricas y colas siguen disponibles. El muestreo de Redis no
es una transacción y puede variar mientras los workers procesan trabajos.

La edad usa la fecha original de creación de BullMQ. Un trabajo recién promovido
desde delayed puede ser antiguo por creación: esta métrica no indica cuánto lleva
disponible ni cuánto lleva en su último reintento. Los trabajos delayed y los que
esperan hijos siguen contando en backlog, pero no en la edad. BullMQ conserva el
timestamp de creación al reintentar y cambia delay a un intervalo relativo al
reintento; sumarlos no permite reconstruir una fecha de disponibilidad fiable.

## Alertas críticas

Ver `alerts.yml`:

1. **APIDown** — `/v1/metrics` no responde 1 min
2. **HighErrorRate** — transiciones FAILED / pagos creados > 10% durante 5 min, sumando por job antes de dividir y exigiendo creaciones > 0. Es un indicador de actividad en una ventana, no errores HTTP ni una cohorte de los mismos pagos.
3. **GatewayCircuitOpen** — `circuit_state == 2` durante 2 min
4. **QueueBacklog / QueueOldestJob** — >1000 trabajos durante 10 min / un trabajo listo o activo creado hace >10 min durante 5 min. La edad no mide tiempo desde su disponibilidad.
5. **QueueMetricsUnavailable / QueueFailedJobs** — consulta Redis fallida durante 2 min / trabajos fallidos retenidos durante 10 min.
6. **EarningReversalOldest / EarningReversalMetricsUnavailable** — una devolución hecha sin descuento de ganancia desde hace más de 30 min durante 5 min / consulta PostgreSQL fallida durante 2 min. `nightpay_earning_reversal_pending` y `nightpay_earning_reversal_oldest_age_seconds` incluyen los reintentos diferidos; el backoff nunca cambia la fecha original del refund. Si falla la consulta se omiten ambos valores, con `nightpay_earning_reversal_metrics_up = 0`.

Se retiró `PayoutsReconcileBacklog`: las transiciones de pagos no medían payouts
pendientes ni la conciliación diaria, que está retirada.

Las pruebas unitarias verifican contratos de reglas y el productor real con colas
simuladas. Si `promtool` ya está disponible, desde este directorio ejecutar
`promtool check rules alerts.yml` y `promtool test rules alerts.test.yml` para
evaluar las series sintéticas de tasas altas, bajas y tráfico cero.

## Dashboard layout

`nightpay.dashboard.json` — 4 rows:
1. **Salud sistema** — uptime, error rate, latencia p50/p99
2. **Pagos** — rate de creación, transiciones FSM, refunds
3. **Treasury** — payouts por método, reconciliación status
4. **Infraestructura** — WS, queue, circuit breakers, memoria/CPU
