# ADR-003: XState FSM + saga de compensación para pagos

**Estado**: Accepted
**Fecha**: 2026-04-21
**Deciders**: Equipo de ingeniería NightPay
**Relacionado**: §8 del Master Plan V2

## Contexto

Un pago NightPay atraviesa ≥7 estados (`CREATED` → `AWAITING_CAPTURE` → `AUTHORIZING` → `AUTHORIZED` / `FAILED` / `EXPIRED` / `REFUNDED` / `PARTIALLY_REFUNDED` / `ORPHAN`). Las transiciones dependen de **múltiples actores asíncronos**:

- Cliente (escanea QR → transición a `AWAITING_CAPTURE`)
- Pasarela (webhook → `AUTHORIZED` o `FAILED`)
- Jobs de expiración (timeout → `EXPIRED`)
- Reconciliación (resolver `ORPHAN`)

Sin un modelo formal, tratamos cada transición con `if/else` dispersos → inevitablemente surgen bugs:
- Pago pasa de `AUTHORIZED` a `AUTHORIZING` (retroceso ilegal) porque llega webhook tarde
- Pago en `EXPIRED` recibe `FAILED` y queda en un limbo
- Race conditions: dos webhooks concurrentes mueven a estados incompatibles

Además, los pagos **pueden terminar "atascados"**: pasarela confirma pero webhook nunca llega. Sin compensación, el pago queda en `AUTHORIZING` para siempre.

## Decisión

### Parte A — Máquina de estados formal con **XState 5**

Definir el ciclo de vida del pago como máquina XState. Propiedades ganadas:
- Transiciones declarativas y **autogrillantes** (eventos inválidos se ignoran en lugar de corromper estado).
- Visualización del grafo (XState inspector).
- Tests unitarios triviales (enviar eventos, asertar estado).
- Guards/actions declarativos (ej. `AUTHORIZED` solo si event.providerTxId está presente).

Implementación: ver §8.1. La FSM vive en `apps/api/src/modules/payments/machine.ts`. Snapshot del estado persistido en `payments.status` (como string).

### Parte B — Transiciones atómicas con lock pesimista

Cada transición se ejecuta dentro de una transacción con `SELECT ... FOR UPDATE`:

```typescript
await prisma.$transaction(async (tx) => {
  const [p] = await tx.$queryRaw`SELECT * FROM payments WHERE id = ${id} FOR UPDATE`;
  // ...construye actor con snapshot, aplica evento, valida transición, persiste
});
```

Esto previene que dos webhooks concurrentes generen transiciones conflictivas.

### Parte C — Saga de compensación para `ORPHAN`

Cuando un pago queda 30 min en `AUTHORIZING` sin recibir webhook:
1. Job `orphan-reconcile` consulta `GET /status` a la pasarela
2. Si pasarela dice `AUTHORIZED` → FSM transiciona a `AUTHORIZED`
3. Si pasarela dice `FAILED` → FSM transiciona a `FAILED`
4. Si pasarela aún `PROCESSING` → reencolar con delay 60s
5. Si >12h en `ORPHAN` sin resolución → alerta P0 para intervención manual

La "compensación" es **reconciliar con la verdad remota**, no revertir. No existe rollback de pago autorizado — si pasarela autorizó, se respeta.

## Alternativas consideradas

### A1. `if/else` ad-hoc en cada controller/worker
- **Pro**: Menos dependencias, curva menor.
- **Contra**: Inevitable drift, bugs sutiles de race conditions, difícil de razonar.
- **Rechazado**: Antipatrón conocido; la deuda crece rápido.

### A2. Workflow engine externo (Temporal, Inngest)
- **Pro**: Workflows durables, reintentos automáticos, visualización.
- **Contra**: Infraestructura extra (Temporal requiere cluster con Cassandra/Postgres + worker containers); Inngest = vendor externo con latencia red y coste mensual.
- **Rechazado**: Overkill para flujo relativamente lineal; XState cubre el 95% del valor con un paquete npm.

### A3. Django/Rails-style `state_machine` gem
- Nota: Node no tiene paquete mayor equivalente maduro.
- **Rechazado** por ecosistema.

### A4. Saga coreografiada (event-driven) sin FSM
- Cada servicio reacciona a eventos sin estado central.
- **Contra**: Nuestro pago es lineal-con-bucles (refund parciales), no requiere coreografía compleja.
- **Rechazado** como overkill.

## Consecuencias

### Positivas
- **Transiciones imposibles son imposibles**: `FAILED → AUTHORIZED` no compila. Bugs ruidosos, no silenciosos.
- **Tests exhaustivos baratos**: enumerar todos los eventos desde todos los estados.
- **Visualización**: XState inspector muestra el grafo — útil para onboarding.
- **Compensación explícita**: el caso `ORPHAN` está modelado, no es un "bug que a veces pasa".
- **Auditoría**: cada transición se registra en `payment_events` con traceId → forense completa.

### Negativas
- **Curva XState**: sintaxis de `setup()` + `createMachine()` requiere aprendizaje (1 día).
- **Snapshot/restore**: reconstruir actor desde estado persistido requiere cuidado (usar `snapshotFrom()`).
- **Transacciones largas**: `FOR UPDATE` mantiene lock hasta commit; mitigado manteniendo transacciones <50ms.

### Neutras
- El resto de dominios (refunds, terminals) no son FSM formales — solo `payments`. No generalizamos prematuramente.

## Criterios de verificación

- [ ] 100% transiciones legales definidas en `machine.ts`; test que enumera estados × eventos
- [ ] Test: enviar evento ilegal (`AUTHORIZED` desde `FAILED`) → no transición + log WARN
- [ ] Test concurrencia: 100 webhooks simultáneos sobre mismo payment → 1 sola transición aplicada
- [ ] Visualización generada en `docs/diagrams/fsm-payment.html` via `@xstate/inspect`
- [ ] Job `orphan-reconcile` tiene test E2E con pasarela mock
- [ ] Métrica `payment_state_transitions_total{from,to}` exportada

## Revisión

Revisar si:
- Flujos nuevos (pulseras prepago, reservas) justifican workflow engine dedicado (Temporal)
- FSM crece a >15 estados (posible split en submachines)
- Lock pesimista se vuelve bottleneck (>500 transiciones/s sobre mismo payment — improbable)
