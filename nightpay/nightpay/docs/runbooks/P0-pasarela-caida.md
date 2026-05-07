# Runbook P0: Pasarela (Wipay / Peanpe) caída

**Severidad**: P0 en ventana nocturna, P1 fuera
**Tiempo objetivo**: 5 min diagnóstico + comunicación ≤10 min

## Síntomas

- Alerta Telegram: `[P0] NightPay: circuit_state{provider="WIPAY"} = OPEN for 5m`
- Dashboard **Overview**: "Payment success rate" desplomado
- Usuarios reportan: "cobros no funcionan"
- Logs: `Circuit open`, `Wipay 502 Bad Gateway`, timeouts repetidos

## Diagnóstico en 30 segundos

1. **Cuál pasarela**:
   ```bash
   curl -s http://localhost:3000/internal/metrics | grep -E '^circuit_state'
   # circuit_state{provider="WIPAY"} 2   ← OPEN
   # circuit_state{provider="PEANPE"} 0  ← CLOSED
   ```

2. **Estado público de la pasarela**:
   - https://status.wipay.com
   - https://status.peanpe.com

3. **Test manual**:
   ```bash
   curl -I https://api.wipay.com/health
   # Expect: 200 en <500ms
   ```

## Acciones

### Si la pasarela confirma incidente en su status page

**Modo degradado automático ya está activo** (circuit breaker abrió). Acciones:

1. **Notificar a venues afectados vía bot Telegram**:
   ```bash
   curl -X POST http://localhost:3000/internal/ops/broadcast \
     -d '{"level":"warn","message":"La pasarela Wipay tiene incidente externo. Los pagos pueden tardar más. Seguimos operando en modo degradado."}' \
     -H "X-Admin-Token: $ADMIN_TOKEN"
   ```

2. **Status page pública**: actualizar `status.nightpay.app` (Uptime Robot o similar)

3. **Si venue tiene Peanpe como secundaria activa**:
   ```sql
   -- verificar
   SELECT tenant_id FROM gateway_credentials
   WHERE provider = 'PEANPE' AND active = true;
   ```
   Esos venues seguirán operando normalmente gracias al fallback ADR-005.

4. **Si venue NO tiene secundaria**:
   - Pagos entran en cola (`QUEUED_FOR_AUTHORIZATION`)
   - UI TPV muestra banner "Pagos en espera — se procesan al restaurar pasarela"

### Si la pasarela dice "all systems normal" pero nosotros vemos fallos

Problema posiblemente nuestro. Checklist:

1. **Red saliente OK**:
   ```bash
   docker exec nightpay_api curl -I https://api.wipay.com/health
   ```
   Si falla desde container pero OK desde host → problema Docker networking.

2. **DNS**:
   ```bash
   docker exec nightpay_api nslookup api.wipay.com
   ```

3. **Credenciales válidas**:
   ```bash
   # Probar auth básica con credencial descifrada
   curl -X POST https://api.wipay.com/v1/ping \
     -H "Authorization: Bearer $DECRYPTED_WIPAY_KEY"
   ```
   Si 401 → clave rotó sin notificar. Actualizar `gateway_credentials` del venue.

4. **Revisar logs recientes**:
   ```bash
   docker logs nightpay_api --since 10m | grep -i wipay | tail -50
   ```

5. **Forzar close del circuit** (si creemos que es falso positivo):
   ```bash
   curl -X POST http://localhost:3000/internal/circuits/wipay/close \
        -H "X-Admin-Token: $ADMIN_TOKEN"
   ```
   Si vuelve a abrirse en 1 min → no era falso positivo, esperar.

## Mientras dura el incidente

- Monitorear panel "Circuit State" en Grafana → cuando `circuit_state = 0` ha estado closed 2 min consecutivos, sistema ha vuelto.
- **NO intentar drenar cola manualmente**: BullMQ workers reintentan al volver el breaker (configurado en §9).
- Verificar que pagos nuevos entran con `status=QUEUED_FOR_AUTHORIZATION` y que cola crece ordenadamente.

## Verificación (sistema restaurado)

```bash
# 1. Circuit closed
curl -s http://localhost:3000/internal/metrics | grep circuit_state
# circuit_state{provider="WIPAY"} 0

# 2. Cola drenada
curl -s http://localhost:3000/internal/queues/payments-lifecycle | jq .waiting
# Expect: número bajo, drenándose

# 3. Success rate recuperado
# En Grafana, panel "Payment success rate" debe volver a >99%
```

- [ ] Tras 10 min con breaker closed, reconciliación manual de pagos que quedaron en `QUEUED_FOR_AUTHORIZATION` durante incidente
- [ ] Notificar a venues: "pasarela restaurada"
- [ ] Status page verde

## Comunicación

Plantilla Telegram a afectados:
```
[NightPay] Incidente pasarela <Wipay/Peanpe>
Detectado: HH:MM
Impacto: pagos en modo degradado (entrada en cola)
Venues afectados: <lista o "todos con Wipay primario">
Estado: monitorizando / en curso / resuelto
ETA: <10min / desconocida / N/A>
```

## Postmortem si

- Incidente duró >30 min
- Afectó a >5 venues simultáneos
- Hubo pérdidas reales de pagos (no recuperados tras restore)
- Descubrimos falso positivo del circuit breaker

## Prevención

- Revisar alertas Grafana — ¿thresholds demasiado sensibles?
- Verificar que secundaria Peanpe esté al día con Wipay para venues grandes
- Considerar pre-aprovisionar segunda pasarela para todos los venues críticos
