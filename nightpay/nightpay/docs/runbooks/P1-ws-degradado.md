# Runbook P1: WebSockets degradados

**Severidad**: P1 (afecta UX pero pagos funcionan)
**Tiempo objetivo**: 20 min

## Síntomas

- Alerta: `[P1] NightPay: ws_reconnection_rate > 10/min for 10m`
- Clientes/TPVs reportan: "el spinner no se quita, tengo que recargar"
- Dashboard **WebSockets**: `ws_connections_active` oscila mucho o cae
- Logs: `disconnect`, `transport error`, `connection dropped`

## Diagnóstico en 30 segundos

1. **Estado Redis (pubsub base)**:
   ```bash
   docker exec nightpay_redis redis-cli ping
   # PONG → Redis OK
   ```

2. **Pubsub propagation**:
   ```bash
   docker exec nightpay_redis redis-cli pubsub numsub socket.io#/#*
   # número de subscribers
   ```

3. **Métricas WS**:
   ```bash
   curl -s http://localhost:3000/internal/metrics | grep ws_
   ```

4. **Test manual de conexión**:
   ```bash
   # Desde máquina externa
   wscat -c "wss://api.nightpay.app/socket.io/?EIO=4&transport=websocket" \
     -H "Authorization: Bearer $TEST_TOKEN"
   ```

## Acciones

### Caso A — Redis pubsub saturado

Síntoma: `redis-cli info clients` muestra `connected_clients` alto + `blocked_clients` >0.

1. **Identificar causa**:
   ```bash
   docker exec nightpay_redis redis-cli client list | head -20
   ```

2. **Si hay clientes huérfanos**: reiniciar API para limpiar conexiones:
   ```bash
   # Solo en un nodo a la vez (rolling)
   docker compose restart api
   ```

3. **Si Redis CPU >80%**: escalar vertically (CPX31 → CPX41) o dedicar instancia Redis.

### Caso B — Firewall/proxy cierra conexiones long-lived

Cloudflare por defecto tiene timeout 100s para WS. Si pagos duran más de eso (no debería):

1. Verificar Cloudflare:
   - Rules > Network > WebSockets: ON
   - Timeout: aumentar a 300s si necesario

2. Sticky sessions (para >1 nodo API):
   - Coolify/Traefik: habilitar `loadBalancer.sticky.cookie`

### Caso C — Browser móvil mata proceso en background

Comportamiento normal en iOS/Android. El fallback polling del frontend (§7.4) ya lo cubre.

Verificar que el fallback está funcionando:
```bash
# Test E2E Playwright específico
pnpm --filter tests e2e --grep "WS reconnect polling"
```

Si el test falla → el fallback tiene bug. Escalar a dev.

### Caso D — Bug del nuevo release

Si las reconexiones empezaron tras un deploy reciente:

```bash
# Rollback rápido (blue/green)
coolify deploy rollback api --target=previous
```

Luego escribir postmortem.

## Verificación

- [ ] `ws_connections_active` estable (no oscilando)
- [ ] `ws_reconnection_rate` < 2/min
- [ ] Test manual: conectar wscat, mantener 60s, no desconecta
- [ ] Playwright test de reconexión pasa en staging

## No es incidente si

- Oscilación correlaciona con horario nocturno (clientes bloquean móvil) — es esperado
- Usuarios móviles son la mayoría → polling fallback debería cubrirlo

## Postmortem si

- Duró >1h
- Afectó pagos reales (clientes confundidos no pudieron completar)
- Requirió rollback de deploy
