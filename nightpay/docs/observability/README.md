# Observability — NightPay

## Stack

| Capa | Producto | Notas |
|---|---|---|
| **Errors** | Sentry | Captura excepciones unhandled + HTTP 5xx. Configurable vía `SENTRY_DSN` env var. |
| **Metrics** | Prometheus + Grafana | `/v1/metrics` expone formato text. Dashboard JSON en `nightpay.dashboard.json`. |
| **Logs** | Pino → stdout | Por defecto a stdout estructurado JSON; en prod recoger con Loki/CloudWatch/etc. |
| **Tracing** | Sentry traces (10% sampling) | Phase 2: OpenTelemetry full traces. |
| **Alerts** | Prometheus Alertmanager | Reglas en `alerts.yml`. |

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
| `nightpay_queue_depth` | Gauge | Backlog BullMQ — alerta si crece |

## Alertas críticas

Ver `alerts.yml`. Las 4 más importantes:

1. **APIDown** — `/v1/metrics` no responde 1 min
2. **HighErrorRate** — 5xx > 5% del total 5 min
3. **GatewayCircuitOpen** — `circuit_state == 2` durante 2 min
4. **PayoutsReconcileBacklog** — pendiente >100€ sin verificar 24h

## Dashboard layout

`nightpay.dashboard.json` — 4 rows:
1. **Salud sistema** — uptime, error rate, latencia p50/p99
2. **Pagos** — rate de creación, transiciones FSM, refunds
3. **Treasury** — payouts por método, reconciliación status
4. **Infraestructura** — WS, queue, circuit breakers, memoria/CPU
