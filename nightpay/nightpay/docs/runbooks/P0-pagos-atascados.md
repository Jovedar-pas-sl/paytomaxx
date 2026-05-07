# Runbook P0: Pagos atascados >30 min

**Severidad**: P0 (despierta guardia si ocurre en ventana nocturna)
**Tiempo objetivo de resolución**: 15 min detección + 15 min fix = 30 min total

## Síntomas

Uno o más de:
- Alerta Telegram: `[P0] NightPay: N payments stuck in AUTHORIZING > 30m`
- Manager reporta: "cliente pagó pero el TPV dice pendiente"
- Dashboard Grafana **Payments deep-dive**: panel "Pagos en AUTHORIZING > 30min" > 0
- Reconciliación diaria falla con status `MISMATCH`

## Diagnóstico en 30 segundos

### Comando único

```bash
ssh ops@prod1.nightpay.app
docker exec -it nightpay_api psql $DATABASE_URL -c "
  SELECT id, tenant_id, amount_cents, status, provider, provider_tx_id,
         NOW() - updated_at AS stuck_for
  FROM payments
  WHERE status IN ('AUTHORIZING', 'AWAITING_CAPTURE')
    AND updated_at < NOW() - INTERVAL '30 minutes'
  ORDER BY updated_at
  LIMIT 50;
"
```

### Interpretar resultado

| `provider_tx_id` | Diagnóstico | Acción |
|------------------|-------------|--------|
| `NULL` | Nunca llegó a pasarela | Sección A |
| Valor presente | Pasarela procesó pero webhook no llegó | Sección B |
| Varios providers mezclados | Problema sistémico | Sección C |

## Acciones

### Sección A — Pago nunca envió request a pasarela

Causas típicas: circuit breaker abierto, worker colgado, config de credenciales inválida.

1. **Verificar circuit breakers**:
   ```bash
   curl -s http://localhost:3000/internal/metrics | grep circuit_state
   # circuit_state{provider="WIPAY"} 2  ← 2 = open
   ```

2. **Verificar credenciales venue**:
   ```sql
   SELECT tenant_id, provider, active, kek_version
   FROM gateway_credentials
   WHERE tenant_id = '<tenant-id-del-pago>';
   ```
   Si no hay fila activa → credenciales faltantes. Contactar manager para reconfigurar.

3. **Si circuit breaker abierto sin razón real** (pasarela OK ahora):
   ```bash
   curl -X POST http://localhost:3000/internal/circuits/wipay/close \
        -H "X-Admin-Token: $ADMIN_TOKEN"
   ```

4. **Disparar reconciliación manual** del pago:
   ```bash
   curl -X POST http://localhost:3000/internal/payments/<id>/reconcile \
        -H "X-Admin-Token: $ADMIN_TOKEN"
   ```

### Sección B — Pasarela procesó pero webhook no llegó

1. **Consultar estado real en pasarela**:
   ```bash
   # Wipay
   curl https://api.wipay.com/v1/transactions/<provider_tx_id> \
     -H "Authorization: Bearer $WIPAY_ADMIN_TOKEN" | jq .status

   # Peanpe
   curl https://api.peanpe.com/payments/<provider_tx_id> \
     -H "X-Api-Key: $PEANPE_KEY" | jq .state
   ```

2. **Si pasarela dice AUTHORIZED**:
   ```sql
   -- transición FSM manual
   UPDATE payments SET status = 'AUTHORIZED', updated_at = NOW()
   WHERE id = '<payment-id>';
   INSERT INTO payment_events(payment_id, tenant_id, event_type, payload, trace_id)
   VALUES ('<payment-id>', '<tenant-id>', 'payment.authorized_manual',
     '{"reason":"manual-reconcile","actor":"ops","provider_tx_id":"..."}',
     'manual-' || gen_random_uuid()::text);
   ```
   Luego emitir evento WS para que TPV/cliente se actualicen:
   ```bash
   curl -X POST http://localhost:3000/internal/ws/emit \
        -d '{"room":"payment:<id>","event":"payment:update","payload":{"status":"AUTHORIZED"}}'
   ```

3. **Si pasarela dice FAILED**: misma operación pero transicionar a FAILED.

4. **Si pasarela dice PROCESSING aún**: reencolar job reconciliación con delay 60s:
   ```bash
   curl -X POST http://localhost:3000/internal/jobs/orphan-reconcile \
        -d '{"paymentId":"<id>","delayMs":60000}'
   ```

### Sección C — Problema sistémico

Si ves >50 pagos atascados en múltiples venues:

1. **Check estado pasarela principal**:
   - https://status.wipay.com
   - https://status.peanpe.com

2. **Check endpoint webhook**:
   ```bash
   curl -i https://api.nightpay.app/v1/webhooks/wipay -XPOST -d '{}' -H 'X-Signature:x'
   # Expect: 401 (firma inválida) — NO 5xx ni timeout
   ```

3. **Check queue `webhooks-ingest`**:
   ```bash
   curl -s http://localhost:3000/internal/queues/webhooks-ingest | jq .
   # Verificar: active, waiting, delayed, failed counts
   ```

4. **Si DLQ tiene >100 items**: pasar a runbook `P0-webhooks-flood.md` (no incluido en set inicial — escribir si pasa).

5. **Si webhook endpoint está 5xx**:
   ```bash
   docker logs nightpay_api --tail 200 | grep -i webhook
   ```
   Posibles causas: DB down, Redis down, OOM. Ir a runbook correspondiente.

## Verificación

Antes de cerrar el incidente:

```sql
-- debe devolver 0
SELECT COUNT(*) FROM payments
WHERE status IN ('AUTHORIZING', 'AWAITING_CAPTURE')
  AND updated_at < NOW() - INTERVAL '30 minutes';
```

- [ ] Dashboard **Overview** muestra panel "Atascados" en verde
- [ ] Reconciliación del día siguiente retorna `OK` para los venues afectados
- [ ] Clientes afectados recibieron confirmación (WS/email)
- [ ] Alerta Telegram se apagó automáticamente

## Postmortem si

- Afectó a >10 pagos o >3 venues
- Tardó >30 min resolverlo
- Se descubrió nueva clase de fallo no cubierta por runbooks existentes

Template: `docs/postmortems/TEMPLATE.md`.

## Prevención futura

- Si causa fue circuit breaker incorrectamente abierto: revisar thresholds en config
- Si causa fue webhook no llegó: verificar configuración retry en pasarela
- Si causa fue reconciliación no disparó: alerta sobre job `orphan-reconcile` que no corre
