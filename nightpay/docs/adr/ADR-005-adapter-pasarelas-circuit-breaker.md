# ADR-005: Adapter pattern + circuit breaker para pasarelas de pago

**Estado**: Accepted
**Fecha**: 2026-04-21
**Deciders**: Equipo de ingeniería NightPay
**Relacionado**: §8.3 del Master Plan V2

## Contexto

NightPay depende de pasarelas externas (**Wipay**, **Peanpe**, futuras) para autorizar pagos. Estas pasarelas:
- Tienen **APIs heterogéneas** (endpoints, formato de payload, esquema de firma, códigos de error).
- **Fallan ocasionalmente**: latencias de 5–30s en horas pico, 5xx transitorios, windows de mantenimiento.
- Pueden cambiar de provider por decisión de negocio (tarifas, soporte, cobertura regional).
- La lógica de pago es **core**: acoplarla a una pasarela específica = refactor mayor al cambiar.

Además, si una pasarela entra en crisis, requests encadenados pueden:
- Agotar pool de conexiones HTTP del backend
- Saturar workers con reintentos ciegos
- Dar timeout a clientes en la UI (>30s)
- Disparar cascada a otros endpoints

## Decisión

### Parte A — Adapter pattern obligatorio

Interfaz única `GatewayAdapter` en `packages/contracts`:

```typescript
export interface GatewayAdapter {
  authorize(input: AuthorizeInput): Promise<AuthorizeResult>;
  getStatus(providerTxId: string): Promise<PaymentStatus>;
  refund(input: RefundInput): Promise<RefundResult>;
  verifyWebhook(headers: Headers, rawBody: Buffer): WebhookVerifyResult;
}
```

Una implementación por pasarela: `WipayAdapter`, `PeanpeAdapter`. Resolución vía DI de NestJS con factory que lee `Venue.gatewayCredentials.provider`.

`PaymentsModule` **nunca** importa clases específicas — solo la interfaz.

### Parte B — Circuit breaker por pasarela

Cada adapter está envuelto en un **circuit breaker** (Opossum):

- **Closed** (normal): requests pasan.
- **Open**: tras 50% errores en ventana de 1 min y ≥10 requests, se abre 30s. Fallback inmediato.
- **Half-open**: tras 30s, permite 1 request de prueba. Si ok → closed; si falla → open otra vez.

```typescript
const breaker = new CircuitBreaker(
  (input) => wipayHttp.authorize(input),
  {
    timeout: 5000,
    errorThresholdPercentage: 50,
    resetTimeout: 30_000,
    volumeThreshold: 10,
    fallback: (input) => this.degraded.enqueueAndPoll(input),
  },
);
```

### Parte C — Modo degradado

Cuando circuit breaker está `open`:
1. **POST /payments** retorna 202 Accepted con `status: QUEUED_FOR_AUTHORIZATION` y el pago queda en cola BullMQ.
2. UI del TPV muestra "Pasarela lenta — cobrando en segundo plano. Verifica importe tras la transacción".
3. Job worker reintenta con backoff exponencial + jitter hasta que el breaker cierre.
4. Al llegar webhook real → transición FSM normal.

Alternativa: **switchover automático** a pasarela secundaria (Peanpe si Wipay cae) — ver Parte D.

### Parte D — Fallback inter-pasarela (opcional fase 2)

Cuando un venue tiene credenciales de **dos** pasarelas activas (`active: true` en `GatewayCredential`), la autorización puede caer a la secundaria si la primaria tiene su breaker open.

Condiciones para activar fallback:
- Venue explicitó segunda credencial (opt-in)
- Pasarela primaria lleva >2 min con breaker open
- Pago aún no envió request al primary (estado `CREATED`, no `AUTHORIZING`)

**No se intenta fallback si la primaria ya respondió `AUTHORIZING`** — riesgo de doble cobro.

## Alternativas consideradas

### A1. Integración directa por pasarela (sin adapter)
- **Pro**: Simpler en V1.
- **Contra**: Cambiar pasarela = reescribir PaymentsModule.
- **Rechazado**: Nos bloquea en el provider elegido.

### A2. Sin circuit breaker — solo timeouts
- **Pro**: Menos piezas.
- **Contra**: Bajo fallo sostenido, workers se saturan con requests que ya sabemos que fallarán.
- **Rechazado**: Experiencia comprobada en fintech.

### A3. Circuit breaker manual (sin Opossum)
- **Pro**: Cero dependencias.
- **Contra**: Reinventar la rueda; Opossum es ~2kb, estable, con eventos observables.
- **Rechazado** por pragmatismo.

### A4. Message broker (Kafka/RabbitMQ) al frente de todas las autorizaciones
- **Pro**: Desacopla completamente.
- **Contra**: Latencia añadida, infraestructura extra, overkill para 500 TPS pico.
- **Rechazado**: BullMQ + Redis cubre el caso con mucho menos.

## Consecuencias

### Positivas
- **Swap de pasarela trivial**: nueva clase implementa interfaz, config apunta a ella.
- **Aislamiento de fallos**: una pasarela caída no bloquea otras operaciones (otros endpoints, jobs).
- **Observabilidad**: métricas `circuit_state{provider}` y `circuit_transitions_total`.
- **UX no degrada catastróficamente**: fallback explícito mejor que timeout ciego.
- **Testing simple**: adapter mock inyectable en tests de integración.

### Negativas
- **Overhead marginal**: Opossum añade ~2ms por request; despreciable vs SLO p95 500ms.
- **Complejidad mental**: ingenieros deben entender que requests asíncronamente cobran sin confirmación inmediata cuando breaker open (documentado en runbook "Pasarela caída").
- **False positives**: si las métricas se desvían, breaker puede abrir cuando pasarela va bien. Mitigación: thresholds conservadores + alerta si `circuit_open_duration > 5min`.

### Neutras
- **Credenciales cifradas**: las claves de pasarela por venue ya están en `GatewayCredential` cifradas AES-256-GCM; adapter las descifra on-demand.
- **Rate limits de la pasarela**: si Wipay limita a 100 RPS por merchant, adapter implementa rate limiter propio para no triggering 429 (evita abrir breaker por rate limit).

## Criterios de verificación

- [ ] `PaymentsModule` solo importa `GatewayAdapter` (verificable con regla eslint custom)
- [ ] Test: swap `provider: 'WIPAY' → 'PEANPE'` en venue config → pago usa Peanpe sin rebuild
- [ ] Test chaos C1: kill mock Wipay → breaker abre en ≤1 min, fallback a cola funciona, no 5xx a cliente
- [ ] Métricas `circuit_state{provider}`, `circuit_errors_total{provider}` en Grafana
- [ ] Runbook "Pasarela caída" documenta modo degradado y tiempos de recovery esperados
- [ ] Test: >2 pasarelas activas → fallback a secundaria respeta regla "solo si no se envió request a primaria"

## Revisión

Revisar si:
- Añadimos 3+ pasarelas y resolver la primaria se vuelve no trivial (posible router inteligente)
- Observamos muchos false positives del breaker (ajustar thresholds o usar sliding window más grande)
- Requerimos latencia <100ms autorización (entonces fallback en cola no basta; considerar pre-autorización o wallet prepagado)
