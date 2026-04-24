# API Reference

Todas las rutas requieren cookie JWT `session` válida excepto donde se indique `(pública)`. Las rutas HTML usan `text/html`; las rutas `/widget/*` y `/alerts/*/ack*` son HTMX (responden HTML o `204 No Content`).

## Auth

| Método | Ruta     | Auth | Descripción |
|--------|----------|------|-------------|
| GET    | `/login` | pública | Formulario login |
| POST   | `/login` | pública | Valida email+password, setea cookie JWT, redirect a `/` |
| GET    | `/logout`| pública | Borra cookie, redirect a `/login` |
| GET    | `/health`| pública | `{"status":"ok"}` — para healthcheck del contenedor |

## Dashboard & Casas

| Método | Ruta             | Descripción |
|--------|------------------|-------------|
| GET    | `/`              | Dashboard: KPIs + heatmap + últimas alertas |
| GET    | `/casas`         | Selector de casas (cards con status + convs hoy) |
| GET    | `/casas/<id>`    | Workspace de la casa. Query: `?tab=chats|metricas|problemas|analisis` · `?period=24h|7d|30d|90d|all` · `?wa=<wa_number_id>|all` |

## Conversación

| Método | Ruta                                  | Descripción |
|--------|---------------------------------------|-------------|
| GET    | `/conversation/<id>`                  | Vista detalle con panel de análisis + merge UI |
| POST   | `/conversation/<id>/send`             | Enviar mensaje (form field `text`). Proxya a WAHA. |
| POST   | `/conversation/<id>/analyze`          | Enqueue `analyze_conversation_job` en arq |
| POST   | `/conversation/<id>/auto-merge`       | IA detecta conv hermana → si confidence≥0.7 hace merge |
| POST   | `/conversation/<id>/merge/<target_id>`| Merge manual forzado |
| GET    | `/conversation/<id>/export.txt`       | Export plano del transcript |

## Media (proxy WAHA)

| Método | Ruta              | Descripción |
|--------|-------------------|-------------|
| GET    | `/media/<msg_id>` | Stream bytes con `X-Api-Key` hacia WAHA. Cache `private, max-age=86400`. |

## Sesiones WhatsApp

| Método | Ruta                                    | Descripción |
|--------|-----------------------------------------|-------------|
| GET    | `/sessions`                             | Lista casas con sus wa_numbers + status de cada session |
| POST   | `/casas`                                | Crear casa. Body: `name` |
| POST   | `/casas/<casa_id>/wa-numbers`           | Añadir WA a una casa. Body: `label`, `session_name` (slug único) |
| POST   | `/wa-numbers/<wa_id>/rename`            | Renombrar label. Body: `label` |
| POST   | `/wa-numbers/<wa_id>/delete`            | Borrar wa_number (CASCADE en convs se hace SET NULL) |
| POST   | `/session/<name>/start`                 | Arrancar session (WAHA) |
| POST   | `/session/<name>/stop`                  | Parar session |
| POST   | `/session/<name>/restart`               | Stop + start |
| POST   | `/session/<name>/logout`                | Destruir auth (requiere re-scan QR) |
| GET    | `/session/<name>/qr`                    | Devuelve QR en PNG para escanear (si status=SCAN_QR_CODE) |

## Alertas

| Método | Ruta                   | Descripción |
|--------|------------------------|-------------|
| GET    | `/alerts`              | Lista. Query: `?show=active|all` |
| POST   | `/alerts/<id>/ack`     | Marca una alerta como vista (`acknowledged_at`) |
| POST   | `/alerts/ack-all`      | Silencia todas las activas |

## Exports

| Método | Ruta                                     | Descripción |
|--------|------------------------------------------|-------------|
| GET    | `/casas/<id>/export/conversations.csv`   | CSV con UTF8-BOM (Excel-ready). Query: `?period=...` |
| GET    | `/casas/<id>/export/analysis.csv`        | Análisis agregado por conv |
| GET    | `/casas/<id>/export/meta-analyses.md`    | Meta-análisis en Markdown |

## HTMX widgets (usados por los templates, no como API pública)

| Método | Ruta                                         | Descripción |
|--------|----------------------------------------------|-------------|
| GET    | `/widget/kpis`                               | Fragmento de las 4 KPI cards (polling 30s) |
| GET    | `/widget/heatmap`                            | Fragmento del heatmap 7×24 |
| GET    | `/widget/conversation/<id>/messages`         | Fragmento de la lista de mensajes (polling 30s) |
| GET    | `/widget/casa/<id>/chats`                    | Fragmento de la lista de chats (filtrable por `?wa=`) |

## Meta-análisis

| Método | Ruta                                     | Descripción |
|--------|------------------------------------------|-------------|
| POST   | `/casas/<id>/meta-analyses`              | Enqueue `meta_analyze_casa_job`. Body: `period` |
| POST   | `/casas/<id>/analyze-pending`            | Enqueue análisis para todas las convs sin `analysis` |

## Webhooks (internos, solo red Docker)

| Método | Ruta              | Auth | Descripción |
|--------|-------------------|------|-------------|
| POST   | `/webhook/waha`   | HMAC opcional | Recibe eventos de WAHA: `message`, `message.any`, `message.ack`, `session.status` |

**Verificación HMAC**: si `WAHA_WEBHOOK_HMAC` está configurado en `.env`, WAHA firma el body con SHA-512 → header `X-Webhook-Hmac`. Si no está, se acepta sin verificar (dev).

**Filtros aplicados**:
- Acepta: `@c.us` · `@lid`
- Rechaza: `@g.us` (grupos), `@broadcast`, `status@broadcast`

## Códigos de respuesta

| Código | Significado |
|--------|-------------|
| 200    | OK con body |
| 204    | OK sin body (ACKs, eventos HTMX sin actualizar outerHTML) |
| 301/302| Redirect legacy → nueva ruta |
| 303    | Redirect tras login/logout |
| 401    | Sin cookie / JWT inválido. Para HTML renderiza `error.html` o redirige a `/login` |
| 404    | Recurso no existe (conv, alerta, message para media) |
| 422    | Validación: body inválido, campo faltante |
| 429    | Rate limit (login) — `LOGIN_RATE_MAX_FAILS` fallos en `LOGIN_RATE_WINDOW_SECONDS` |
| 502    | Upstream WAHA no responde o devuelve error al proxy de media |
