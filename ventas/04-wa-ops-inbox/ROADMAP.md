# ROADMAP — 4 semanas a venta real

> Objetivo: pasar de "prototipo interno funcionando en una casa" a "puedo facturar a 3 casas externas sin yo tocar la infra cada vez".

Las semanas son secuenciales pero algunas tareas se solapan (señaladas con `║`).

---

## Semana 1 — Multi-tenant real

Hoy `casas` existe en el modelo pero la app implícitamente asume **1 admin = todas las casas**. Hay que aislar.

- [ ] **Aislamiento de tenant en queries**
  - Añadir `casa_id` obligatorio en `CurrentUser` y propagar a cada query
  - Revisar `queries.py` end-to-end: ningún `SELECT` sin filtro por `casa_id` (excepto rutas admin global)
  - Tests: usuario de casa A no puede leer mensajes de casa B (403)
- [ ] **Roles `owner` vs `operator` vs `superadmin`**
  - Tabla `users` con `role` enum
  - `superadmin` (yo) ve panel global de todas las casas
  - `owner` ve su casa
  - `operator` (mamai) ve solo conversaciones, sin coaching nominal
- [ ] **Onboarding wizard de casa nueva**
  - Ruta `/admin/casa/new` → crea tenant + primer usuario owner + envío email invitación
  - Generación de `slug` único para subdominio (`maxxag.kpi.waops.es`)
- [ ] **Migración Alembic 0013** con índices `casa_id` en todas las tablas hot

**Definition of done:** crear casa B desde panel admin, login owner-B, ver solo conversaciones de B, intentar acceder a conv de A por URL → 404.

---

## Semana 2 — Billing Stripe + SEPA ║ Hardening WAHA + Caddy

### Billing (Stripe principalmente)

- [ ] **Producto en Stripe** con 3 prices (Starter / Pro / Scale) + price por línea
- [ ] **Webhook `/billing/stripe`** → activa/desactiva casa según `subscription.status`
- [ ] **Customer Portal de Stripe** embebido para que el cliente gestione tarjeta y facturas
- [ ] **Add-on facturación SEPA manual** para clientes >6 meses (genera factura, marca pagado a mano la primera versión — no automatizar SEPA en sprint 1)
- [ ] **Dunning básico**: si `subscription.past_due` → email al owner + banner amarillo en dashboard a los 3 días → suspender análisis IA a los 10 días → suspender WAHA a los 14
- [ ] **Página `/billing` interna**: estado de subscripción, líneas activas, próximo cargo, descargar facturas

### Hardening (║ paralelo)

- [ ] **Caddy:** rate limiting por IP (`rate_limit` plugin), HSTS, X-Frame-Options DENY, CSP estricto
- [ ] **WAHA Plus:** API key rotada por casa, swagger detrás de basic-auth distinto al admin, IP allowlist opcional
- [ ] **fail2ban**: ban tras 5 logins fallidos en `/auth/login` en 5 min
- [ ] **Logs centralizados**: enviar `kpi-app` y `waha` a archivo rotado + alerta email si nivel ERROR > N/hora
- [ ] **Backup remoto** — Backblaze B2 + restic (ya identificado como pendiente en MEMORY, mover aquí)

**Definition of done:** primer cobro real automatizado, hardening pasa un escaneo OWASP ZAP sin findings críticos.

---

## Semana 3 — Onboarding self-service ║ Plan rotación de números

### Onboarding self-service

- [ ] **Landing → demo → signup** sin tocar yo nada
  - Formulario público `/signup` → crea tenant en estado `trial`
  - Email con link mágico al wizard
  - Wizard: nombre casa, número de líneas estimado, tarjeta (Stripe Checkout)
- [ ] **Conexión QR de WhatsApp** desde wizard (ya existe la ruta `/qr-share`, hay que pulir UX)
- [ ] **Plantillas de configuración** por tipo de casa (1 ciudad / multi-ciudad / club / piso)
- [ ] **Onboarding email drip** (5 emails en 14 días)

### Plan rotación de números

- [ ] **Documento `docs/RUNBOOK_ROTATION.md`** con procedimiento:
  - Cómo identificar un número en riesgo (warmup tracker, ratio reportes/mensajes)
  - Cómo conectar el número de relevo en paralelo (ya soportado, pero documentar)
  - Cómo migrar conversaciones activas al nuevo número (UI mover conversación)
  - Cómo comunicar a clientes activos el cambio (template mensaje masivo controlado)
- [ ] **Métrica "salud de número"** en dashboard: días activo, ratio respuesta, último mensaje recibido (heurística pre-ban)

**Definition of done:** primer cliente externo (no Maxxag) llega a la landing, paga, conecta sus números y empieza a usar el inbox sin intervención manual mía.

---

## Semana 4 — SLA, exports, cierre comercial

- [ ] **SLA contractual** (template `legal/SLA.md`):
  - 99.5 % uptime kpi-app
  - <5 min tiempo de respuesta a incidente CRITICAL en horario 09-22 CET
  - Compensación: prorrateo si < SLA del mes
- [ ] **Status page pública** (`status.waops.es`) — Uptime Kuma o equivalente
- [ ] **Exports a CSV/Excel**: conversaciones, mensajes, alerts, métricas mensuales (ya parcial en `routes/exports.py`)
- [ ] **Informe mensual automatizado** PDF → email al owner el día 1 de cada mes
- [ ] **Página pricing pública** con calculadora de precio por nº de líneas
- [ ] **Programa de referidos**: 10 % descuento permanente por casa referida que se quede >3 meses
- [ ] **Cierre comercial**: 3 propuestas firmadas (incluida Maxxag formalizada)

**Definition of done:** primer mes facturado real, status page verde, informe PDF entregado.

---

## Tareas continuas (todas las semanas)

- [ ] Demo grabada de 90 s actualizada en landing
- [ ] FAQ pública mantenida en `landing/faq.html`
- [ ] Test E2E con Playwright de los flujos críticos (login, conectar WA, ver conversa, ver análisis)
- [ ] Métricas internas: nº casas activas, líneas activas, MRR, churn, coste Claude por casa

---

## Fuera de scope de los 4 sprints (parking lot)

- App móvil nativa (la web responsive es suficiente sprint 1-2)
- Integración con CRM externos (HubSpot, etc.)
- Multi-idioma UI (ES es suficiente; ya está en ES)
- IA generativa para responder por la chica (riesgo de ban Meta + ética; lo posponemos)
- Voz / audio transcripción (Whisper) — ya viene en pipeline pero no prioritario sprint 1
