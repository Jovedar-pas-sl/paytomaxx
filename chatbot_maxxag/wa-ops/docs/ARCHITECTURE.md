# Architecture

## Vista global

```
                      ┌─────────────┐
                      │   Browser   │
                      └──────┬──────┘
                             │ HTTPS (Let's Encrypt)
                             ▼
                      ┌─────────────┐
                      │   Caddy 2   │  :80 :443
                      └──────┬──────┘
                             │ proxy
        ┌────────────────────┼────────────────────┐
        │                    │                    │
        ▼                    ▼                    ▼
  ┌───────────┐        ┌───────────┐        ┌───────────┐
  │  kpi-app  │        │   WAHA    │        │  (admin   │
  │ FastAPI   │◄──────►│   Plus    │        │  redirect)│
  └────┬──────┘        └─────┬─────┘        └───────────┘
       │                     │ webhook
       │                     ▼
       │              ┌──────────────┐
       │              │ /webhook/waha│
       │              │ upsert msg + │
       │              │ arq.enqueue  │
       │              └──────┬───────┘
       │                     │
       ▼                     ▼
  ┌──────────┐         ┌──────────┐
  │ Postgres │◄───────►│  Redis   │
  │    16    │         │ (arq Q)  │
  └──────────┘         └─────┬────┘
                             │ consume
                             ▼
                      ┌─────────────┐
                      │ kpi-worker  │
                      │ (arq)       │
                      │ ── analyze_ │
                      │    conv_job │
                      │ ── meta_    │
                      │    casa_job │
                      │ ── cron:    │
                      │    waha_    │
                      │    health   │
                      └──────┬──────┘
                             │ Claude API
                             ▼
                     ┌───────────────┐
                     │ Anthropic SDK │
                     │ Haiku 4.5     │
                     └───────────────┘
```

## Flujos clave

### 1. Mensaje entrante → análisis IA

1. Cliente envía WhatsApp → WAHA recibe (engine NOWEB) → dispara webhook `POST /webhook/waha`.
2. [`webhooks.py:_handle_message`](../kpi-app/app/routes/webhooks.py) verifica HMAC (si configurado), filtra `@g.us` y `@broadcast`, hace UPSERT de `contact` + `conversation` + INSERT en `message` (idempotente por `waha_msg_id`).
3. Si el mensaje es nuevo y `direction=in`, bumpea `unread_count`. Si además la conv es "solo entrantes" y hay una hermana "solo salientes" de hace <2h en la misma casa/WA, crea alerta `merge_suggestion` (idempotente).
4. Cuando el cliente completa el threshold (ver [`worker.py`](../kpi-app/app/analyzer/worker.py)), se enqueue `analyze_conversation_job`.
5. Worker fetchea mensajes, corre 6 skills en paralelo (`asyncio.gather`), UPSERT en tabla `analysis`. Red flags críticos → alerta; p90>30min → alerta.

### 2. Admin envía mensaje desde panel

1. UI `conversation.html` → `POST /conversation/<id>/send` con texto.
2. [`conversation.py:send_message`](../kpi-app/app/routes/conversation.py) resuelve la `session` de WAHA (del `wa_number` de la conv), llama `WahaClient.send_text`.
3. WAHA envía al cliente; tras enviar, WAHA dispara otro webhook `message.any` con `fromMe=true` que se ingesta normalmente (direction=out).
4. Actualiza ACKs (entregado / leído) vía webhook `message.ack`.

### 3. Media (imagen / vídeo / audio / documento)

1. Webhook trae `hasMedia: true` + `media.url` + `media.mimetype`. Guarda URL + mime en `message.media_url/media_mime`.
2. Template renderiza `<img src="/media/<id>">` / `<video>` / `<audio>` según el mimetype.
3. Browser hace GET `/media/<id>` → [`routes/media.py`](../kpi-app/app/routes/media.py) lookup, autentica al admin, `WahaClient.open_media_stream(url)` con `X-Api-Key`, streamea bytes al browser con el mime correcto.

### 4. Recuperación de sesiones WAHA (cron)

Cron corre cada 60s en `kpi-worker`. Para cada `wa_number`:

1. Consulta `GET /api/sessions/<session>` a WAHA.
2. Estado `WORKING` → limpia claves de recuperación en Redis.
3. Estado `STOPPED|FAILED|SCAN_QR_CODE` → transiciones en 3 fases usando state Redis (`wa:recov:<wa_id>:{started,next_stop_at,next_start_at,fails}`):
   - Fase A: stop + start (primer intento)
   - Fase B: esperar ventana más larga tras fallo repetido
   - Fase C: delete + recreate tras >15 min en FAILED (pierde QR — alerta al admin)
4. Circuit breaker: tras 60 fallos consecutivos, pausa intentos.
5. Solo 1 llamada WAHA por WA por tick — NO bloquea event loop.

### 5. Auto-fusión IA de conversaciones separadas

Cuando el mismo cliente escribe al `@c.us` y al `@lid` crea 2 conversaciones. Admin pulsa "Fusionar con cliente (IA)" → [`conversation.py:auto_merge`](../kpi-app/app/routes/conversation.py):

1. Fetch conv objetivo + sus primeros 30 mensajes.
2. Lista conv-candidatos (mismo casa, mismo wa_number, <7 días).
3. [`skills.detect_same_client`](../kpi-app/app/analyzer/skills.py) pasa a Claude el target + candidatos etiquetados → devuelve `{best_match_id, confidence}`.
4. Si `confidence >= 0.7`, ejecuta el merge (mueve mensajes, unifica contact, marca la antigua como merged).

### 6. Meta-análisis de casa

Periódico (manual por admin). Muestra 50 convs de la casa → Claude → patrones de cliente tipo, fortalezas, mejoras de conjunto. Persiste en tabla `meta_analysis`.

## Contenedores

| Servicio | Imagen | Rol |
|----------|--------|-----|
| `caddy` | `caddy:2-alpine` | TLS, reverse proxy |
| `postgres` | `postgres:16-alpine` | DB única `kpi` |
| `redis` | `redis:7-alpine` | arq queue + cache state |
| `waha` | `devlikeapro/waha-plus:latest` | Bridge WhatsApp multi-sesión |
| `kpi-app` | build local | FastAPI web |
| `kpi-worker` | build local (mismo Dockerfile) | arq worker + cron |

Red interna `internal` (bridge). Caddy expone :80 y :443. Todo lo demás interno.

## Persistencia (volúmenes)

| Volumen | Qué guarda | Backup crítico |
|---------|------------|----------------|
| `pg_data` | Postgres datadir | ✅ Sí |
| `redis_data` | RDB + AOF | ⚠️ Opcional (cache/queue) |
| `waha_data` | `.sessions/` — auth de WhatsApp | ✅ **Crítico** (perder = re-escanear QR) |
| `caddy_data` | certificados TLS | Opcional (regenera en 30s) |
| `caddy_config` | config caché | Opcional |

`scripts/backup.sh` tar+restic cifrado diario.

## Rendimiento

- Latencia típica del webhook → db: < 50 ms
- Latencia del skill pipeline (6 en paralelo): 2–3 s contra Claude Haiku 4.5
- Polling HTMX de mensajes en `conversation.html`: 30 s con gate `document.visibilityState==='visible'`
- Polling HTMX de KPIs en dashboard: 30 s con el mismo gate
- `asyncpg` pool: por defecto 10 conexiones. Puestas a mano en `deps.py` si subes tráfico.

## Observabilidad

- Logs: `docker compose logs -f <svc>`. Niveles estándar Python (WARNING / INFO / DEBUG).
- Alertas de app en tabla `alert`, visibles en `/alerts`.
- Healthcheck HTTP: `GET /health` (no requiere auth).
- Caddy loguea accesos en stdout.

Sin métricas Prometheus / tracing todavía — queda como P2 en el backlog.
