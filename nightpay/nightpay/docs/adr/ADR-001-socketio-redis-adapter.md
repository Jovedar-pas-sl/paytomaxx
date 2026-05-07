# ADR-001: Socket.io con Redis adapter desde el día 1

**Estado**: Accepted
**Fecha**: 2026-04-21
**Deciders**: Equipo de ingeniería NightPay
**Relacionado**: §10 del Master Plan V2

## Contexto

NightPay tiene 3 frontends (cliente móvil, TPV, admin) que necesitan recibir **eventos de pago en tiempo real** (`payment:update`, `payment:completed`). Implementado con **Socket.io** sobre WebSockets (fallback a polling HTTP).

El backend NestJS arranca inicialmente en **un único nodo** (1 VPS Hetzner). Por tanto, un Socket.io single-process funcionaría técnicamente.

Sin embargo:
1. Los picos de salida de concierto exigen hasta **500 TPS** y >3000 conexiones WS concurrentes en ventana nocturna. Un solo nodo está al límite.
2. El modelo de negocio contempla onboardear múltiples venues — crecimiento en conexiones será lineal con adopciones.
3. Si el sistema se vuelve popular, llegar a **2 nodos API** es cuestión de meses, no años.
4. En ese momento: un evento emitido desde el nodo A **no llegará** a clientes conectados al nodo B → bugs de "no llegó la confirmación".
5. **Migrar retroactivamente** Socket.io a arquitectura multi-nodo cuando ya hay usuarios reales es doloroso: requiere coordinar cambios de infra, adaptador, sticky sessions, testing de regresión en flujos críticos (pago).

## Decisión

**Instalar y configurar `@socket.io/redis-adapter` desde el primer deploy**, aunque inicialmente haya un solo nodo API.

Redis 7 ya es una dependencia del stack (cache + BullMQ + sesiones). Añadir pub/sub para Socket.io **no suma infraestructura** — solo ~2 conexiones adicionales al mismo Redis.

```typescript
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';

const pubClient = new Redis(process.env.REDIS_URL);
const subClient = pubClient.duplicate();

@WebSocketGateway({
  adapter: createAdapter(pubClient, subClient),
  cors: { origin: ALLOWED_ORIGINS },
})
export class RealtimeGateway { /* ... */ }
```

Emisiones con `this.io.to('payment:123').emit(...)` se propagan automáticamente por pub/sub a todos los nodos.

## Alternativas consideradas

### A1. Socket.io single-node hasta que hagamos falta más nodos
- **Pro**: Más simple, una dependencia menos inicialmente.
- **Contra**: Refactor futuro bajo presión (producción con usuarios). Riesgo de bugs sutiles.
- **Rechazado**: El coste marginal de añadir adapter día 1 es bajísimo; el coste de migrar bajo carga es alto.

### A2. Server-Sent Events (SSE) en lugar de WS
- **Pro**: Más simple, unidireccional, "funciona en todos los proxies".
- **Contra**: No bidireccional → cliente no puede emitir `payment:subscribe`, `ack`, etc. con latencia similar. Requiere inventar canal secundario (fetch POST) para esos eventos.
- **Rechazado**: La interacción real-time es bidireccional (subscribe/unsubscribe/ack), WS encaja mejor.

### A3. Pusher / Ably / servicio externo
- **Pro**: Delegamos escalado y operación.
- **Contra**: €50+/mes desde día 1; latencia extra (round-trip a edge); datos de pagos pasando por tercero; vendor lock-in.
- **Rechazado**: Infra propia es viable con Hetzner + Redis ya existentes; coste casi cero.

## Consecuencias

### Positivas
- **Escalado horizontal** transparente: basta con `docker compose up --scale api=N` + sticky sessions en Cloudflare (o Coolify).
- **Cero refactor** cuando toque escalar (solo infra).
- **Test multi-nodo** viable localmente desde el día 1 (`docker compose up --scale api=2`).
- **Fault tolerance**: si un nodo muere, clientes reconectan al superviviente; eventos siguen entregándose.

### Negativas
- **2 conexiones Redis** adicionales por nodo (pub + sub). Impacto: despreciable.
- **Latencia extra de ~1ms** por evento (round-trip pub/sub local). Aceptable para objetivo p95 <300ms end-to-end.
- **Redis es SPOF** para realtime. Mitigación: en §13 se contempla modo degradado con fallback polling del cliente.

### Neutras
- Necesitamos sticky sessions cuando haya >1 nodo (Cloudflare `ip_cookie` policy o Coolify traefik sticky). Trivial de configurar pero no por defecto.
- Monitoreo: añadir métricas `ws_pubsub_lag_seconds` y `redis_subscriptions` a Grafana (§12).

## Criterios de verificación

- [ ] Test local: `docker compose up --scale api=2`; cliente conectado a nodo 1 recibe evento emitido desde nodo 2
- [ ] Métrica `ws_connections_active{node}` exportada a Grafana
- [ ] Runbook "Redis caído" (§16) documenta modo degradado de WS
- [ ] Load test k6 con 3000 conexiones WS concurrentes verificado en staging

## Revisión

Revisar esta decisión si:
- Pasamos de 10k conexiones WS concurrentes (entonces considerar uWebSockets.js nativo o stack distinto)
- Redis se convierte en bottleneck de pub/sub (raro <100k msg/s)
- Aparece una necesidad de multi-región (requeriría Redis cluster o solución diferente)
