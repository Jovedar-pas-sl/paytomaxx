# Runbook — Operación diaria & troubleshooting

Manual de referencia cuando algo va mal. Reglas rápidas primero; detalles después.

---

## Diagnóstico rápido

```bash
# Estado de contenedores
docker compose ps
# → 6 servicios: caddy, postgres, redis, waha, kpi-app, kpi-worker

# Healthcheck del backend
curl -s https://kpi.<DOMAIN>/health
# → {"status":"ok"}

# Sessions WAHA (desde dentro del contenedor)
docker exec maxxag-wa-ops-waha-1 curl -s -H "X-Api-Key: $WAHA_API_KEY" \
  http://localhost:3000/api/sessions | jq .

# Últimas 100 líneas de logs
docker compose logs --tail 100 kpi-app
docker compose logs --tail 100 kpi-worker
docker compose logs --tail 100 waha
```

---

## Problemas frecuentes

### Templates / UI no se actualizan tras scp

**Síntoma**: subes un template, reinicias el contenedor, pero la UI sigue vieja.

**Causa**: el Dockerfile hace `COPY app ./app` en build-time — los templates están **baked in** la imagen. `docker compose restart` no recrea la imagen.

**Fix**:
```bash
cd /opt/wa-ops
docker compose build kpi-app
docker compose up -d --force-recreate kpi-app
# + kpi-worker si cambiaste código Python de worker
```

### WAHA session cae a FAILED o STOPPED

**Síntoma**: en `/sessions` una session aparece en rojo. Mensajes no llegan.

**Causa probable**: conflict con WhatsApp Web en otro dispositivo ("Stream Errored conflict"), o auth caducada.

**Fix**: el cron del worker intenta auto-recovery (stop+start → esperar → delete+recreate). Si tras 15 min sigue FAILED, la session se recrea y necesitas re-escanear QR manualmente:

```
UI → /sessions → botón ▶ Iniciar en la WA roja → aparece QR → escanea
```

Si quieres forzar el recovery desde shell:
```bash
docker exec maxxag-wa-ops-waha-1 curl -X POST \
  -H "X-Api-Key: $WAHA_API_KEY" \
  http://localhost:3000/api/sessions/<name>/restart
```

### "Error 422 — solo 1 session permitida"

**Causa**: estás usando la imagen `devlikeapro/waha:latest` (Free) en vez de `waha-plus:latest`.

**Fix**:
```bash
docker login -u devlikeapro -p 'dckr_pat_TU_KEY'
docker pull devlikeapro/waha-plus:latest
docker logout

# Verifica que docker-compose.yml diga waha-plus:latest en el servicio waha:
grep "image:" docker-compose.yml

docker compose up -d --force-recreate waha
```

### Webhook HMAC rechaza todos los eventos (401)

**Síntoma**: logs de kpi-app muestran `webhook HMAC invalid`.

**Causa**: mismatch entre el secreto en `.env` y el que WAHA está enviando, o formato de header distinto.

**Fix temporal**: vacía `WAHA_WEBHOOK_HMAC=` en `.env`, restart kpi-app + waha. El webhook acepta sin firma (solo si no estás expuesto externamente).

**Fix permanente**: genera nuevo secreto, actualiza en `.env`, restart ambos contenedores:
```bash
openssl rand -hex 32          # copia el output
# edita .env → WAHA_WEBHOOK_HMAC=<output>
docker compose up -d waha kpi-app
```

### Migraciones — cambios no reflejados

**Síntoma**: añadiste una columna en una migración, pero las queries fallan.

**Causa**: no ejecutaste `alembic upgrade head`.

**Fix**:
```bash
docker compose exec kpi-app alembic current
docker compose exec kpi-app alembic upgrade head
```

Bajar una migración:
```bash
docker compose exec kpi-app alembic downgrade -1
```

### Fail2ban baneó tu IP SSH

**Síntoma**: `ssh_dispatch_run_fatal: Connection to <IP> port 22: Connection timed out` tras varios intentos de password.

**Diagnóstico** (desde Browser Terminal del proveedor VPS u otra consola que no use SSH):
```bash
fail2ban-client status sshd
# → Banned IP list: 93.176.173.242
```

**Fix**:
```bash
fail2ban-client set sshd unbanip <TU_IP>
```

Si recurre, configura SSH con keys (ver DEPLOY.md → Hardening).

### kpi-app healthcheck failing, contenedor en restart loop

**Síntoma**: `docker compose ps` muestra kpi-app reiniciando continuamente.

**Diagnóstico**:
```bash
docker compose logs kpi-app --tail 50
```

Causas comunes:
- `DATABASE_URL` mal formado → revisa `.env`
- Postgres aún no listo → verifica `postgres` está `healthy`
- `alembic upgrade head` falla por schema inconsistente → ejecuta manual
- `KPI_ADMIN_PASSWORD_HASH` no tiene formato bcrypt → regenera con `scripts/hash-admin-password.py` (escapa los `$` si lo pegas en heredocs bash)

### Media no se muestra en el chat

**Síntoma**: en `conversation.html` ves un recuadro vacío donde debería ir la foto/vídeo.

**Diagnóstico**:
```bash
# 1. ¿Tiene URL/mime en DB?
docker compose exec postgres psql -U kpi -d kpi -c \
  "SELECT id, media_url, media_mime FROM message WHERE conversation_id=<ID> ORDER BY id DESC LIMIT 10;"

# 2. ¿Responde el proxy /media/<id>?
curl -I -b "session=<TU_COOKIE>" https://kpi.<DOMAIN>/media/<MSG_ID>

# 3. ¿WAHA sirve la media?
docker exec maxxag-wa-ops-waha-1 curl -sI -H "X-Api-Key: $WAHA_API_KEY" "<media_url>"
```

Si WAHA da 404, la media caducó (NOWEB engine la guarda temporalmente). Pide al cliente re-enviarla.

### "fail2ban no instalado" al diagnosticar

```bash
apt-get update && apt-get install -y fail2ban
systemctl enable --now fail2ban
```

### Alembic: "duplicate key" al crear un wa_number

**Síntoma**: crear una 2ª session con el mismo `session_name` da error.

**Causa**: `session` es UNIQUE global, no por casa.

**Fix**: usa slugs únicos (`vlc-oficial`, `madrid-oficial`, no repetir `oficial`).

### Analyzer: Conversación sin análisis IA

**Diagnóstico**:
```bash
docker compose logs kpi-worker --tail 50

# ¿Cola vacía?
docker compose exec redis redis-cli -n 1 LLEN arq:queue:default
```

Causas comunes:
- `ANTHROPIC_API_KEY` vacía/inválida → revisa `.env`
- Créditos Anthropic agotados → console.anthropic.com > Billing
- Worker crasheado → `docker compose restart kpi-worker`
- Job bloqueado en arq → reinicia redis `docker compose restart redis kpi-worker`

### Caddy no consigue certificado HTTPS

**Síntoma**: navegador da error de certificado; logs Caddy muestran "challenge failed".

**Causas**:
- DNS A record no propagado (espera 5-10 min)
- Puerto 80 bloqueado por firewall (necesario para Let's Encrypt HTTP-01)
- Rate limit Let's Encrypt (5 intentos fallidos/hora — espera 1h)

**Test**:
```bash
dig +short kpi.<DOMAIN>
curl -I http://kpi.<DOMAIN>        # debe devolver 308 → HTTPS
```

---

## Mantenimiento

### Logs rotativos

Docker rota por defecto con `json-file`. Limita tamaño en `/etc/docker/daemon.json`:

```json
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "50m", "max-file": "5" }
}
```

Reinicia Docker: `systemctl restart docker`.

### Backups

Diario vía cron (ver DEPLOY.md §7). Verifica periódicamente:
```bash
ls -la /var/backups/wa-ops/
bash scripts/restore-backup.sh --list
```

### Actualizar WAHA Plus

```bash
docker login -u devlikeapro -p 'dckr_pat_TU_KEY'
docker pull devlikeapro/waha-plus:latest
docker logout
docker compose up -d --force-recreate waha
```

Los datos de sesión en volumen `waha_data` persisten.

### Vacuum

Postgres 16 hace autovacuum. Si notas bloat:
```bash
docker compose exec postgres psql -U kpi -d kpi -c "VACUUM ANALYZE;"
```

### Rotar password admin

```bash
python3 scripts/hash-admin-password.py        # imprime hash
# copia a .env → KPI_ADMIN_PASSWORD_HASH=...
docker compose up -d kpi-app
```

---

## Monitoring externo recomendado

Apunta un ping externo a `https://kpi.<DOMAIN>/health`:
- **UptimeRobot** (gratis hasta 50 monitores)
- **BetterStack**

Si `/health` ≠ 200 → alerta por SMS/email.

---

## Escalado

Si Haiku empieza a dar análisis poco precisos:
1. Cambia modelo a `claude-sonnet-4-6` en `settings.py` (`claude_model`)
2. Sonnet cuesta 3× más por token pero con caching agrupado reduce gastos significativamente
3. Eventualmente meter prompt caching en `_call_json()` (reutilizar system prompt entre skills)

---

## Escalation de incidentes

| Situación | Primer reflejo |
|-----------|----------------|
| Mensajes no llegan pero WhatsApps "online" | revisar logs webhook + WAHA |
| KPI panel no carga | revisar Caddy (certificados) + kpi-app healthcheck |
| Alerts spam de red flags | revisar prompt `RED_FLAGS_PROMPT` por falsos positivos |
| Pánico total | `docker compose down && docker compose up -d`; si persiste, restaura backup más reciente |

---

## Contactos externos

- Anthropic API status → status.anthropic.com
- WAHA issues → https://waha.devlike.pro/docs + Patreon Discord
- Hostinger VPS → hpanel.hostinger.com soporte
