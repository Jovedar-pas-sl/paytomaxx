# Claude Code — Project Context

> Lee este fichero al empezar cualquier sesión de Claude Code sobre este proyecto. Condensa lo que necesitas saber para no romper cosas.

## Qué es esto

Dashboard admin auto-hospedado para operar un inbox de WhatsApp multi-casa con análisis IA. Un solo usuario admin. Stack: FastAPI + HTMX + WAHA Plus + Claude Haiku 4.5 + Postgres + Redis + arq.

## Reglas duras — incumplir rompe producción

1. **Templates Jinja2 se compilan en build-time**. El Dockerfile hace `COPY app ./app`, así que cambios en templates **requieren `docker compose build kpi-app`**, no basta con `restart`. Flujo correcto:
   ```
   scp ... root@VPS:/opt/wa-ops/kpi-app/app/templates/
   ssh root@VPS "cd /opt/wa-ops && docker compose build kpi-app && docker compose up -d --force-recreate kpi-app"
   ```

2. **Proyecto en el VPS está en `/opt/wa-ops`**, no en `/root/wa-ops`. Siempre usa `/opt/wa-ops` en los comandos ssh.

3. **WAHA Plus, no Free**. La imagen es `devlikeapro/waha-plus:latest`. Sin esto, solo 1 sesión permitida (error 422 al añadir la 2ª). El pull requiere login con Docker Hub patreon token (una vez).

4. **Filtros del webhook** (`routes/webhooks.py:_handle_message`):
   - ✅ `@c.us` — teléfonos normales
   - ✅ `@lid` — modo privacy moderno (NO filtrar, es legítimo)
   - ❌ `@g.us` — grupos (filtrados a propósito; el modelo es 1 conv = 1 cliente)
   - ❌ `@broadcast` — status/difusión
   - Para fromMe=true, el chat_id es `data.get("from")`, NO `data.get("to")` — NOWEB no expone `to`.
   - `contact_name` solo se asigna cuando `not from_me` (pushName de fromMe es el nombre del usuario admin, no del destinatario).

5. **Auto-merge de conversaciones es solo sugerencia desde webhook**. El webhook crea `alert` tipo `merge_suggestion`; la fusión real la confirma el admin vía `/conversation/<id>/auto-merge` (IA) o dropdown manual. Nunca mutamos datos desde el webhook.

6. **Health-check cron (worker.py)** usa state en Redis (`wa:recov:<wa_id>:*`) para recuperar sesiones WAHA. NO uses `asyncio.sleep` largo — bloquea el event loop. Máx 1 llamada WAHA por WA por tick. Circuit breaker a 60 fallos consecutivos.

7. **Skills del analizador son independientes** y se ejecutan en `asyncio.gather()` paralelo (~2-3s, no suma). Cada una falla aislada; usa `return_exceptions=True` cuando lo añadas para evitar que un fallo tumbe el resto.

8. **Structured outputs de Claude** pasan por `_fix_schema()` (skills.py) que elimina constraints no soportadas (ej. `exclusiveMinimum` en números) y añade `additionalProperties: false`. Si añades un skill, respeta este pipe.

## Arquitectura de un vistazo

```
Browser <-[HTTPS]- Caddy <-[HTTP]- FastAPI (kpi-app)
                              │
                              ├─→ asyncpg pool  → Postgres
                              ├─→ arq queue     → Redis
                              ├─→ httpx client  → WAHA Plus
                              └─→ anthropic SDK → Claude Haiku 4.5

WhatsApp ─[QR pair]─→ WAHA ─[webhook]→ /webhook/waha → DB (upsert msg)
                                                    → arq.enqueue(analyze)

arq worker (kpi-worker):
  ├─ analyze_conversation_job  — fan-out 6 skills
  ├─ meta_analyze_casa_job     — 50 convs sample → patrones
  └─ waha_health_check (cron)  — recuperación stateful de sesiones
```

Detalle completo en [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Tablas en [docs/SCHEMA.md](docs/SCHEMA.md). Endpoints en [docs/API.md](docs/API.md).

## Archivos críticos

| Archivo | Importancia | Antes de tocar |
|---------|-------------|----------------|
| `kpi-app/app/routes/webhooks.py` | **Crítico** — ingestión | Leer reglas de filtrado arriba |
| `kpi-app/app/analyzer/skills.py` | Alto — pipeline IA | Respetar `_fix_schema`, `_call_json` |
| `kpi-app/app/analyzer/worker.py` | Alto — cron + jobs | No bloquear event loop |
| `kpi-app/app/queries.py` | Alto — todo el SQL | Parametrizar siempre; no f-strings |
| `kpi-app/alembic/versions/*.py` | Crítico — migraciones | No editar una migración ya aplicada en prod; crear nueva |
| `docker-compose.yml` | Medio | Verificar variables `.env` al cambiar servicios |
| `Caddyfile` | Bajo | Si cambias subdominios, actualiza DNS antes |

## Patrones a reusar (no reinventar)

- **`CurrentUser` dependency** (`deps.py`) — auth JWT cookie obligatorio en toda ruta excepto login/health/webhook
- **`_call_json(system, user, schema)`** (`skills.py`) — llamada a Claude con structured output; respeta max_tokens=800 buffer
- **`KpiDB`, `Waha`, `Arq`** — inyecciones via `Annotated[X, Depends(...)]` en `deps.py`
- **`_fix_schema`** — obligatorio antes de enviar JSON schema a Claude (Haiku rechaza ciertas keywords)
- **`list_messages_for_conversation(kpi, conv_id)`** — siempre pagina a 500 msgs
- **Templates**: heredan de `base.html`, que ya trae `.card`, `.glass-card`, `.glass-card-btn`, `.glass-segment`, `.btn-primary`, `.btn-3d`, `.mono` — reusar estas clases antes de añadir CSS

## Convención de despliegue

El servidor VPS (ej: `root@72.62.190.116`) está en Hostinger. Todos los paths en `/opt/wa-ops`. Flujos:

```bash
# Templates solo — rebuild obligatorio
scp <templates> root@VPS:/opt/wa-ops/kpi-app/app/templates/
ssh root@VPS "cd /opt/wa-ops && docker compose build kpi-app && docker compose up -d --force-recreate kpi-app"

# Python code (routes, queries, analyzer, AGENT/reply engine)
# ⚠️ kpi-app y kpi-worker son IMÁGENES SEPARADAS. La lógica de respuesta del bot
# (app/agent/*, queries) corre en el WORKER → hay que reconstruir AMBAS o el
# worker seguirá con el código viejo (build de un solo servicio = síntoma:
# "desplegué y el bot sigue igual"). Usa `docker compose build` (sin nombre) o
# `build kpi-app kpi-worker`. Y tras recrear kpi-app, `restart waha` (IP nueva).
scp <files> root@VPS:/opt/wa-ops/kpi-app/app/<subpath>/
ssh root@VPS "cd /opt/wa-ops && docker compose build && docker compose up -d --force-recreate kpi-app kpi-worker && docker compose restart waha"

# Migrations
scp kpi-app/alembic/versions/*.py root@VPS:/opt/wa-ops/kpi-app/alembic/versions/
ssh root@VPS "cd /opt/wa-ops && docker compose exec kpi-app alembic upgrade head"

# Solo compose o Caddyfile
scp docker-compose.yml root@VPS:/opt/wa-ops/
ssh root@VPS "cd /opt/wa-ops && docker compose up -d"
```

## No hacer (lecciones de sesiones previas)

- ❌ No commitear `.env` ni `.env.chatwoot` — tienen secretos reales
- ❌ No usar `asyncio.sleep` >1s en cron jobs del worker — rompe el loop
- ❌ No filtrar @lid en webhook — son usuarios legítimos con privacy moderno
- ❌ No auto-fusionar desde webhook — solo sugerir via alert
- ❌ No ejecutar `cat << EOF` (heredoc bash) en PowerShell — usa Browser Terminal de Hostinger
- ❌ No cachear templates Jinja con TTL — siempre re-builds en deploy
- ❌ No usar modelo `claude-haiku-4-5-20251001` con suffix — usar exact string `claude-haiku-4-5`
- ❌ No añadir `budget_tokens` si usas Opus 4.7 / 4.6 / Sonnet 4.6 — usa `thinking: {type: "adaptive"}`

## Idioma

UI en español neutro (ES-ES). Logs en inglés. Commits en inglés (convencional). Comentarios de código en inglés o español según fit — no mezclar dentro del mismo archivo.
