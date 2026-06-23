# tech-stack — Qué entregamos exactamente

> Documento técnico que recibe la agencia partner al firmar. Incluido en plan Starter en adelante. Versión pública aquí; la versión interna añade credenciales Patreon WAHA + claves PGP firmas releases.

---

## Resumen ejecutivo

Stack-en-Caja se entrega como un **Docker-Compose multi-servicio** desplegable en cualquier VPS Linux con 4 GB RAM mínimo, 2 vCPU, 40 GB SSD. La agencia gestiona el hosting; nosotros mantenemos las imágenes, prompts y migraciones.

---

## Componentes del stack

### 1. Caddy 2 (reverse proxy)

- Imagen: `caddy:2-alpine`
- Función: terminación TLS, HTTPS automático vía Let's Encrypt, sub-domains dinámicos por tenant
- Volúmenes: `caddy_data`, `caddy_config`
- Puertos: 80, 443
- Configuración: `Caddyfile` plantilla con variables `${DOMAIN}`, `${AGENCY_SLUG}`

### 2. Postgres 16 (DB principal)

- Imagen: `postgres:16-alpine`
- Función: persistencia multi-tenant
- Esquema: ~14 tablas (agencies, tenants, users, whatsapp_accounts, conversations, messages, conversation_skills, alerts, audit_log, branding_configs, api_keys, webhooks, billing_events, sessions)
- Migrations: Alembic versionado, `alembic upgrade head` en boot
- Backup: dump diario + WAL streaming opcional vía add-on

### 3. Redis 7 (cola + cache)

- Imagen: `redis:7-alpine`
- Función: cola arq para análisis IA, cache de respuestas WAHA, rate-limit token buckets
- Persistencia: AOF activado, `appendonly yes`
- Limit: 512 MB memoria, política `allkeys-lru`

### 4. WAHA Plus (bridge WhatsApp)

- Imagen: `devlikeapro/waha-plus:latest`
- Función: pasarela HTTP ↔ WhatsApp, multi-sesión, engine NOWEB
- Requisito: subscripción Patreon agencia (~9 €/mes) → `docker login` antes del pull
- Webhook: HMAC sha512 firmado, recibido en `/webhook/waha`
- Volumen: `waha_data` (sesiones autenticadas, NO borrar)
- Eventos suscritos: `session.status`, `message`, `message.any`, `message.ack`

### 5. FastAPI app (`kpi-app`)

- Build custom desde `./kpi-app/Dockerfile`
- Stack: Python 3.12, FastAPI, asyncpg, Jinja2, HTMX
- Función: API REST + dashboard HTMX + receptor webhooks WAHA
- Endpoints clave: `/webhook/waha`, `/dashboard/*`, `/admin/*`, `/api/v1/*`, `/health`
- Autenticación: JWT cookie + API keys para integración externa

### 6. arq worker (`kpi-worker`)

- Mismo Docker image que `kpi-app`, role distinto (`ROLE=worker`)
- Jobs:
  - `analyze_conversation_job` — fan-out 6 skills Claude Haiku 4.5 paralelo
  - `meta_analyze_casa_job` — análisis agregado tenant cada 6h
  - `waha_health_check_job` — cron, recuperación sesiones caídas
  - `backup_job` — opcional, restic + B2 si configurado
- Concurrency: 4 workers por defecto, ajustable vía env

### 7. Widget JS embebible

- Snippet `<script src="https://{agency}.com/widget/v1.js?tenant={slug}"></script>`
- Función: chat IA conversacional en la web del cliente final
- Reutiliza pipeline `chatbot_maxxag/wordpress-plugin` portado a vanilla JS
- Bundle: ~28 KB gzip

### 8. wa-ops Dashboard

- Servido por `kpi-app` en `/dashboard`
- HTMX + Tailwind (CDN o build local) + Geist font
- Vistas: Inbox multi-línea, KPIs tenant, KPIs agencia, Alertas, Coaching feed

---

## Entregables al firmar contrato

### Inmediatos (día 0)

- [ ] Acceso GitHub repo privado `stack-en-caja-deploy` (release tags)
- [ ] Docker images: `ghcr.io/stack-en-caja/kpi-app:vX.Y.Z`, `ghcr.io/stack-en-caja/kpi-worker:vX.Y.Z`
- [ ] `docker-compose.yml` chárter + `docker-compose.override.example.yml`
- [ ] `.env.example` con todas las variables documentadas
- [ ] `Caddyfile.example` con dominio variabilizado
- [ ] Script `install.sh` interactivo
- [ ] Script `deploy.sh`, `backup.sh`, `restore.sh`, `upgrade.sh`
- [ ] Migrations Alembic versionadas
- [ ] 6 prompts Claude Haiku 4.5 (`prompts/mood.md`, `treatment.md`, `conversion.md`, `red_flags.md`, `coaching.md`, `response_time.md`)

### Documentación (entregada en wiki privada)

- [ ] `INSTALL.md` — despliegue paso a paso
- [ ] `UPGRADE.md` — política versionado + migración entre versiones
- [ ] `BACKUP.md` — estrategia backups + restore
- [ ] `TROUBLESHOOTING.md` — errores comunes y solución
- [ ] `RUNBOOK.md` — operativa diaria (WAHA caído, OOM Postgres, rate limit Claude)
- [ ] `API.md` — endpoints públicos con ejemplos curl
- [ ] `SCHEMA.md` — modelo de datos con diagramas
- [ ] `BRANDING.md` — cómo customizar colores, logo, dominio
- [ ] `RGPD.md` — modelo DPA + listado subprocessors
- [ ] `MANUAL_COMERCIAL.md` — argumentario por vertical para la agencia

### Knowledge base inicial

- [ ] 5 KB-packs verticales: hostelería, clínicas estéticas, ocio nocturno, inmobiliaria, talleres
- [ ] Cada pack: 30-50 docs `manual_browser`-format con FAQ típicas
- [ ] Plantillas para la agencia editar/ampliar
- [ ] Pipeline ingesta: PDF, web, Google Docs

### Material comercial co-brandeable

- [ ] 1-pager PDF editable (Figma / Canva)
- [ ] Deck pitch 12 slides editable
- [ ] Plantillas emails: prospección frío, follow-up, propuesta, onboarding
- [ ] Vídeos demo screencast (6 piezas, 3-5 min c/u) co-brandeables

---

## Requisitos del VPS (cliente cumple)

| Recurso | Mínimo | Recomendado | Notas |
|---------|--------|-------------|-------|
| vCPU | 2 | 4 | Picos análisis IA |
| RAM | 4 GB | 8 GB | Postgres + Redis + WAHA + apps |
| Disco SSD | 40 GB | 80 GB | Crece con mensajes + media |
| Ancho banda | 1 TB/mes | 5 TB/mes | Media WhatsApp |
| OS | Ubuntu 22.04 LTS | Ubuntu 24.04 LTS | Otras distros no oficialmente soportadas |
| Docker | 24+ | 26+ | con Compose v2 |

**Proveedores recomendados:** Hetzner Cloud (CX22 europa ~6 €/mes, CCX23 LATAM ~14 €/mes), DigitalOcean Droplet 4GB, Contabo VPS S.

---

## Política versionado

- Semver: `MAJOR.MINOR.PATCH`
- MAJOR: breaking changes (avisamos 60 días)
- MINOR: features nuevas, retro-compatible
- PATCH: bug fixes, seguridad
- Releases mensuales (MINOR) + patch ad-hoc
- Cada release: notas, migración Alembic, video changelog 2-3 min
- Soporte ventana: versión actual + 1 anterior (no se da soporte 2 versiones atrás)

---

## SLA por tier

| Tier | Primera respuesta (incidente crítico) | Primera respuesta (consulta general) | Canal |
|------|---------------------------------------|--------------------------------------|-------|
| Starter | 48 h hábiles | 5 días hábiles | Email |
| Growth | 24 h hábiles | 48 h hábiles | Email + Slack |
| Agency | 8 h hábiles | 24 h hábiles | Slack + WhatsApp directo |
| Premium 24/7 add-on | 2 h cualquier día | 8 h cualquier día | WhatsApp + WhatsApp directo + teléfono |

**Definición crítico:** stack caído, pérdida datos, brecha seguridad. Todo lo demás es consulta general.

---

## Lo que NO entregamos

- Hosting (lo paga y gestiona la agencia)
- Cuentas WhatsApp ni números (las trae la agencia/cliente final)
- Subscripción WAHA Plus Patreon (la paga la agencia)
- Anthropic API key (incluida en €/mes/cliente; no la cedemos)
- Soporte al cliente final PYME (lo hace la agencia 1er nivel)
- Pasarela de pago (cliente final usa la suya o la del WiPay si aplica)
- Trabajo de venta a clientes finales (lo hace la agencia)
- Personalizaciones código fuente del motor (excepto add-on custom dev por horas)
