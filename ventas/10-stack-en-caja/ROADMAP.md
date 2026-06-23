# ROADMAP — Stack-en-Caja (10-14 semanas a producto white-label)

> Objetivo: pasar del stack Maxxag-específico a un producto entregable a agencias terceras con onboarding maduro, branding configurable y soporte escalable.

---

## Fase 0 — Pre-flight (semana 0)

- [ ] Decidir nombre comercial definitivo (Stack-en-Caja vs alternativas)
- [ ] Registrar dominio `.com` y `.es`
- [ ] Crear repo `stack-en-caja-core` (privado) separado de `chatbot_maxxag`
- [ ] Configurar GitHub org + branch protection
- [ ] Decisión legal: SL vs autónomo (ver `DECISIONS.md`)

---

## Fase 1 — Multi-tenancy duro (semanas 1-3)

### Objetivo
Que un mismo despliegue Docker-Compose soporte N agencias y, dentro de cada agencia, N clientes finales aislados.

### Tareas

- [ ] Tabla `agencies` (super-tenant raíz): id, name, slug, plan_tier, licence_expires_at, branding_config jsonb
- [ ] Tabla `tenants` (cliente final): id, agency_id (FK), name, slug, subdomain, plan, created_at
- [ ] Migrar tabla `casas` actual → `tenants` (Maxxag será un tenant de la agencia "interna")
- [ ] Row-level security Postgres por `agency_id` y `tenant_id`
- [ ] Middleware FastAPI que resuelva `request.host` → `agency` + `tenant`
- [ ] Auditar TODAS las queries que hoy no filtran por casa_id
- [ ] Refactor `whatsapp_accounts`, `conversations`, `messages` → añadir `tenant_id` con FK + índice
- [ ] Tests integración: tenant A NO puede leer datos de tenant B (asserts SQL directos)
- [ ] Script migración datos existentes (Maxxag) sin downtime

**Criterio de salida:** 2 tenants con datos distintos en mismo stack, sin filtración cruzada en 100 % de endpoints.

---

## Fase 2 — Panel agencia con sub-cuentas (semanas 3-5)

### Objetivo
3 niveles de acceso: super-admin (nosotros), admin-agencia (partner), admin-tenant (cliente final).

### Tareas

- [ ] Rol `super_admin` (nosotros): ve TODAS las agencias y todos los tenants
- [ ] Rol `agency_admin` (partner): ve solo SU agencia y los tenants de su agencia
- [ ] Rol `tenant_admin` (cliente final): ve solo SU tenant
- [ ] Rol `tenant_operator` (recepcionista): ve solo inbox y conversaciones de SU tenant
- [ ] Página `/admin/agencies` (solo super-admin)
- [ ] Página `/agency/dashboard` (admin-agencia): listado tenants, billing, branding settings
- [ ] Página `/agency/tenants/new` con wizard provisioning (crea tenant + subdomain + WAHA session)
- [ ] Soft-delete tenant + retención datos 30 días
- [ ] Invitación email para crear cuenta admin-tenant

**Criterio de salida:** demo agencia ficticia con 3 tenants, cada uno con su propio admin que NO ve a los otros.

---

## Fase 3 — Branding configurable (semanas 5-6)

### Objetivo
Que cada agencia pueda customizar UI sin tocar código.

### Tareas

- [ ] Tabla `branding_configs` por `agency_id`: logo_url, primary_color, secondary_color, font_family, product_name, support_email, custom_domain
- [ ] Pintar variables CSS dinámicas en `<head>` según `agency_id` activo
- [ ] Subir logo (S3 / Backblaze B2 / volumen local) — máx 500 KB, PNG/SVG
- [ ] Preview en vivo en el panel admin-agencia (HTMX)
- [ ] Custom domain por tenant (`cliente.tu-agencia.com`) con auto-emit Caddy via `tls.on_demand`
- [ ] Plan Agency: eliminar TODA mención "Stack-en-Caja" de UI, emails y docs públicos
- [ ] Templates email transaccionales con variables `{{ agency.name }}` / `{{ agency.support_email }}`

**Criterio de salida:** agencia ficticia con logo, colores y dominio propios indistinguibles de software propio.

---

## Fase 4 — Docs API + manuales agencia (semanas 6-8)

### Objetivo
Que la agencia pueda integrar / extender sin nosotros.

### Tareas

- [ ] OpenAPI 3.1 spec generada de FastAPI (`/openapi.json` ya disponible)
- [ ] Docs públicas `/docs` (Scalar o Stoplight) con ejemplos curl
- [ ] Endpoints público auth: API key por agencia con scope (read-only / write / admin)
- [ ] Webhooks salientes configurables por tenant (mensaje recibido, alerta crítica, conversación cerrada)
- [ ] Rate limiting por API key (Redis token bucket)
- [ ] Manual técnico agencia: `INSTALL.md`, `UPGRADE.md`, `BACKUP.md`, `TROUBLESHOOTING.md`
- [ ] Manual comercial agencia: argumentario vertical (hostelería, clínicas, ocio, inmobiliaria)
- [ ] Vídeos screencast onboarding (3-5 min cada uno, 6 piezas)

**Criterio de salida:** una agencia hipotética puede desplegar e integrar sin Slack/email a nosotros — solo docs.

---

## Fase 5 — Instalador (semanas 8-9)

### Objetivo
Reducir tiempo despliegue de "2-3h manuales" a "20 min guiado" o "10 min 1-click".

### Tareas

- [ ] Script `install.sh` interactivo (pregunta dominio, email, API keys WAHA/Anthropic, genera `.env` + `docker-compose.override.yml`)
- [ ] Validación pre-vuelo: ¿hay Docker? ¿hay 4 GB RAM libres? ¿puerto 443 libre? ¿DNS apunta aquí?
- [ ] Plantilla Hetzner Cloud Init (1-click deploy desde panel Hetzner)
- [ ] Plantilla DigitalOcean Marketplace (eventual, post-MVP)
- [ ] Health-check post-install: ¿WAHA arranca? ¿Caddy emite cert? ¿Postgres acepta conexiones?
- [ ] Modo gestionado: nuestro panel super-admin crea VPS en Hetzner via API y despliega solo
- [ ] Telemetría opt-in básica (versión del stack en uso, número de tenants, sin datos sensibles)

**Criterio de salida:** persona técnica con 0 contexto despliega instancia funcional en <30 min.

---

## Fase 6 — Facturación + sub-billing (semanas 9-11)

### Objetivo
Cobrar a agencias y, opcional, sub-cobrar a clientes finales.

### Tareas

- [ ] Integración Stripe Billing: suscripciones anuales + facturas automáticas
- [ ] Webhook Stripe → activar / suspender licencia agencia
- [ ] Página facturas auto-servicio para agencia (descarga PDF, histórico, próximo cobro)
- [ ] Modo "sub-billing": agencia puede facturar a sus tenants vía Stripe Connect (opcional, plan Growth+)
- [ ] Cálculo automático "clientes finales desplegados activos" → factura mensual variable
- [ ] Política suspensión: 14 días grace tras factura impagada, después tenant read-only, después suspend stack
- [ ] Plantillas Stripe en castellano + IVA por país (ES 21 %, MX 16 %, AR exento, etc.)

**Criterio de salida:** ciclo end-to-end completo: agencia firma → paga → recibe email con setup → despliega.

---

## Fase 7 — Programa Partner Certified (semanas 11-12)

### Objetivo
Convertir agencias activas en canal de captación.

### Tareas

- [ ] Página pública `/partners` con listado agencias certified
- [ ] Sello descargable PNG/SVG "Stack-en-Caja Certified Partner"
- [ ] Tracking referidos (URL params + cookie 90 días)
- [ ] Cálculo revenue share automático en panel agencia
- [ ] Caso de éxito conjunto: plantilla + 3 entrevistas piloto a agencias activas
- [ ] Programa "Partner of the Quarter" con incentivo (10 % off siguiente renovación)

**Criterio de salida:** ≥2 agencias activas certified, ≥1 caso de éxito publicado.

---

## Fase 8 — Hardening producción (semanas 12-14)

### Objetivo
Estabilidad para escalar a 20+ agencias sin contratar.

### Tareas

- [ ] Backups remotos (Backblaze B2 + restic, encriptado, retención 30d)
- [ ] Monitoreo: UptimeRobot / BetterStack endpoints `/health` por agencia
- [ ] Logs centralizados (Loki + Grafana, opcional)
- [ ] Plan de incidencias: runbook por tipo de fallo (WAHA caído, Postgres OOM, Claude rate limit)
- [ ] Política versionado semántico (semver) + changelog público
- [ ] Pipeline release: tag → build images → publish → docs
- [ ] Security review externo (pentest light, ~1.500 €)
- [ ] DPA standard firmable + listado subprocessors actualizado
- [ ] Stress test: 10 agencias x 50 tenants x 100 msgs/h por tenant = 50k msgs/h

**Criterio de salida:** stack lleva 4 semanas en producción multi-agencia sin incidente crítico.

---

## Checklist de salida a venta real

Listo para vender Starter cuando:
- [ ] Fases 1-5 completas
- [ ] 1 agencia piloto desplegada y operando

Listo para vender Growth cuando:
- [ ] Fases 1-6 completas
- [ ] Branding profundo demostrable
- [ ] Sub-billing funcional

Listo para vender Agency cuando:
- [ ] Fases 1-8 completas
- [ ] ≥3 agencias activas
- [ ] Caso de éxito publicado
- [ ] DPA firmado por al menos 1 agencia con cliente final adult-friendly

---

## Riesgos identificados y mitigación

| Riesgo | Impacto | Mitigación |
|--------|---------|------------|
| Soporte 2º nivel se dispara | Alto | Docs maduras + comunidad partner Slack + límite SLA por tier |
| WAHA Plus cambia pricing | Medio | Cláusula contractual: subimos a agencia con 60d notice |
| Anthropic sube precio Claude | Medio | Pass-through automático en €/mes/cliente |
| Agencia revende y "se va sola" | Bajo | Stack sigue funcionando pero sin updates → eventualmente vuelven |
| Compliance RGPD país por país | Medio | DPA standard + subprocessor list + onus en agencia (es su VPS) |
| Burnout founder | Alto | Soporte SLA solo en horas de oficina hasta tener 5+ agencias |
