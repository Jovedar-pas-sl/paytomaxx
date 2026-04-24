# Maxxag WA Ops

Dashboard admin para operar inbox de WhatsApp multi-casa con análisis IA conversación por conversación.

> Stack auto-hospedado, diseñado para un único operador admin. HTMX + FastAPI + WAHA Plus + Claude Haiku 4.5.

---

## Qué hace

- **Inbox propio**: Un chat estilo WhatsApp Web con todas las conversaciones agrupadas por casa. Envío de mensajes desde el panel. Media (fotos/vídeos/audios) renderizada inline.
- **Multi-WhatsApp por casa**: Cada casa puede tener N WhatsApps conectados (oficial, secundario, recepción, marketing…). Sub-pestañas por WA dentro del workspace.
- **Análisis IA por conversación** (6 skills en paralelo):
  1. `mood` — estado del cliente (curioso / decidido / indeciso / enfadado / calentón / timewaster)
  2. `response_time` — p50 / p90 / max de la 1ª respuesta (determinístico, sin LLM)
  3. `treatment` — trato de la mamai en 4 ejes (cariñoso / profesional / vendedor / seco)
  4. `conversion` — probabilidad 0.0–1.0 de cierre
  5. `red_flags` — detecta menores, insultos, fraude, acoso, timewasters → alertas automáticas
  6. `coaching` — recomendaciones accionables con citas textuales (qué fue bien, oportunidades perdidas, ejemplo de respuesta)
- **Meta-análisis**: Muestra 50 conversaciones de una casa con Claude → perfil del cliente tipo, fortalezas, mejoras.
- **Auto-fusión IA**: Cuando el mismo cliente escribe al oficial y al secundario (@lid/@c.us privacy split), la IA identifica y une las conversaciones con confianza ≥ 0.7.
- **Alertas**: red flags críticos, respuesta lenta, WhatsApps desconectados, sugerencias de fusión.

## Stack

| Capa | Tecnología |
|------|------------|
| Proxy HTTPS | Caddy 2 (Let's Encrypt auto) |
| Inbox bridge | **WAHA Plus** (`devlikeapro/waha-plus:latest`) — multi-session sin límite |
| Almacenamiento | Postgres 16 + Redis 7 |
| Web backend | FastAPI + asyncpg + arq worker |
| Frontend | HTMX + Tailwind CDN + Jinja2 + Geist font |
| Analizador | Claude Haiku 4.5 vía Anthropic SDK, structured outputs (JSON schema) |
| Orquestación | Docker Compose, `restart: unless-stopped` |

## Requisitos

- VPS Linux Ubuntu 22.04+ (4 CPU / 8 GB RAM / 80 GB SSD mínimo; 6 CPU / 16 GB para >20 WA)
- Dominio propio con DNS gestionable
- **Anthropic API key** con créditos
- **WAHA Plus Patreon** (~9 €/mes) para multi-sesión — sin esto estás limitado a 1 WhatsApp total

## Setup rápido

```bash
# 1. Clona
git clone <repo-url>
cd wa-ops

# 2. Bootstrap VPS (Docker, UFW, fail2ban, secretos aleatorios)
bash scripts/install-vps.sh

# 3. Rellena .env
nano .env
#   DOMAIN=                  ej: maxxagops.com
#   ANTHROPIC_API_KEY=       tu clave sk-ant-...
#   WAHA_API_KEY=            clave interna (cualquier random)
#   WAHA_DASHBOARD_*=        credenciales del swagger de WAHA
#   KPI_ADMIN_EMAIL=         email admin
#   KPI_ADMIN_PASSWORD_HASH= ejecuta scripts/hash-admin-password.py

# 4. DNS (apunta al IP del VPS)
#   kpi.<DOMAIN>     →  <IP>
#   wa.<DOMAIN>      →  <IP>   (swagger WAHA)

# 5. Login Docker Hub con tu key de WAHA Plus Patreon (una vez)
docker login -u devlikeapro -p <dckr_pat_key>
docker pull devlikeapro/waha-plus:latest
docker logout

# 6. Up
docker compose up -d

# 7. Primer login en https://kpi.<DOMAIN>
#    → /sessions → crea casa → añade WhatsApp → escanea QR
```

Docs detallados: [docs/DEPLOY.md](docs/DEPLOY.md).

## Estructura

```
wa-ops/
├── Caddyfile              # Reverse proxy + HTTPS
├── docker-compose.yml     # Caddy · Postgres · Redis · WAHA · kpi-app · kpi-worker
├── .env.production.template
├── scripts/               # install, backup, restore, hash-admin-password
├── kpi-app/
│   ├── Dockerfile
│   ├── alembic/           # 7 migraciones
│   └── app/
│       ├── main.py        # FastAPI entry, routers
│       ├── deps.py        # lifespan, auth, DI
│       ├── settings.py    # Pydantic config
│       ├── queries.py     # todo el SQL (asyncpg)
│       ├── waha_client.py # cliente HTTP async hacia WAHA
│       ├── models.py      # Pydantic DTOs (skills + kpis)
│       ├── analyzer/
│       │   ├── prompts.py    # 6 prompts de skills + meta + merge-detect
│       │   ├── skills.py     # 6 funciones async + _call_json()
│       │   ├── worker.py     # arq jobs + cron health check
│       │   └── meta_analysis.py
│       ├── routes/        # alerts, analysis_ops, auth, casa_workspace, casas_hub,
│       │                  # conversation, exports, health, media, sessions, webhooks, widgets
│       ├── templates/     # Jinja2 (base, dashboard, casa_workspace, conversation,
│       │                  # sessions, alerts, casas_select, login, partials/*)
│       └── static/        # app.js, img/lips.png
└── docs/
    ├── ARCHITECTURE.md    # Flujos de datos + diagrama
    ├── SCHEMA.md          # Tablas + relaciones
    ├── API.md             # Endpoints reference
    ├── DEPLOY.md          # Deploy detallado
    └── RUNBOOK.md         # Troubleshooting
```

## Operación

```bash
# Logs
docker compose logs -f kpi-app
docker compose logs -f kpi-worker
docker compose logs -f waha

# Rebuild tras cambiar código Python / templates
docker compose build kpi-app
docker compose up -d --force-recreate kpi-app

# Alembic
docker compose exec kpi-app alembic current
docker compose exec kpi-app alembic upgrade head

# Backup manual
bash scripts/backup.sh
```

Más en [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Seguridad

- JWT cookies `HttpOnly` + `Secure`, bcrypt cost 12 para el password admin
- WAHA protegido con `WAHA_API_KEY` (header `X-Api-Key`)
- UFW cierra todos los puertos excepto 22 / 80 / 443
- fail2ban activo sobre `sshd`
- HMAC SHA-512 disponible para webhooks de WAHA (opcional, ver `.env`)
- Media proxy requiere auth de admin — browsers no pueden bajar direct desde WAHA

## Licencia

Uso interno. Contacto para preguntas comerciales.
