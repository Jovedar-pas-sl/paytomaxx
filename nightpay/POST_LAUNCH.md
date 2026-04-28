# NightPay — TODO post-lanzamiento

Issues identificados durante audit (Sprint 7) que **NO bloquean el lanzamiento**
pero conviene atacar tras los primeros días en producción.

## Sprint 7 ya cubrió (críticos para abrir caja)

- [x] `ENOSYS` dotenv-cli watch → carga env directa en `bootstrap-env.ts`
- [x] 2FA TOTP real con speakeasy (User.totpSecret en DB)
- [x] SQL parametrizado en `PrismaService.withTenantTransaction` (validación UUID)
- [x] Helmet + CSP en producción
- [x] CORS estricto via env `CORS_ORIGINS`
- [x] Rate limit global 200 req/min/IP via @fastify/rate-limit
- [x] Body limit 1MB
- [x] Global exception filter (RFC 7807 ProblemDetails, sin stack en prod)
- [x] Login lockout (5 intentos fallidos → 15 min bloqueo)
- [x] Race condition en `startAuthorization` mitigada (FSM como fuente de verdad)
- [x] Timeouts AbortSignal en gateway calls (`GATEWAY_TIMEOUT_MS=5000`)
- [x] Circuit breaker opossum en Wipay/Peanpe adapters
- [x] Pre-persist provider antes de authorize (cierra ventana orphan-reconcile sin txId)

## Pending — orden recomendado

### Inmediatos (primeras 2 semanas en producción)

- [ ] Migrar lockout de login a Redis (multi-nodo). Hoy en memoria → no escala
- [ ] Audit log global: tabla `audit_log` + interceptor `@Audit()` que graba role changes, refunds, credenciales
- [ ] CLI `set-credential` que cifra api_key real con AES-256-GCM + KEK
- [ ] CLI `enroll-totp` para que cada manager configure su autenticador
- [ ] CLI `reconcile --venue --day` para replays manuales
- [ ] Backups configurados en Task Scheduler / cron del VPS (no del Windows local)
- [ ] Monitor stuck-payments con bot Telegram real
- [ ] Status page pública (Uptime Robot free)

### Segundo mes

- [ ] Tests E2E Playwright para los 12 escenarios del master plan §2.3
- [ ] Métricas OpenTelemetry → Grafana Cloud free
  - `payments_created_total{venue, provider}`
  - `payment_authorize_duration_seconds`
  - `circuit_state{provider}`
  - `ws_connections_active`
  - `queue_depth{queue}`
- [ ] Drill de restore mensual (probar PITR)
- [ ] Pre-aprovisionar segunda credencial (Peanpe) para venues críticos — fallback automático
- [ ] Game day chaos engineering (kill pasarela, kill Redis, flood webhooks)

### Tercer mes / cuando crezca

- [ ] Particionado mensual de `payment_events` con `pg_partman` (ADR-004) — cuando >100M filas
- [ ] Réplica read-only de Postgres para queries de admin/analytics
- [ ] PgBouncer para connection pooling
- [ ] Escala horizontal: 2 nodos API tras balanceador con sticky sessions
- [ ] Refresh tokens + revocación (hoy JWT 12h sin revocación)
- [ ] WAL archiving cada 5 min → S3 (RPO 5 min vs RPO 24h actual)

## Issues de baja prioridad (cosmetic / cleanup)

- [ ] Compartir `pickHeader()` helper entre adapters (DRY)
- [ ] Validar `NEXT_PUBLIC_*` env vars en frontends al boot
- [ ] Resource limits (CPU/memory) en `docker-compose.yml`
- [ ] Cache de QR PNG generation (mismo amount + terminal → mismo PNG?)
- [ ] Toggle `npmInstallFromLockfile` falible en `bootstrap.sh`

## Issues no aplicables a tu caso (ignorar)

- ~~Connection pooling PgBouncer~~ — para 6 venues no es necesario hasta 50k req/día
- ~~CDN multi-región~~ — clientes solo España, una zona Cloudflare basta
- ~~Multi-cloud~~ — Hetzner único es suficiente
- ~~Kubernetes~~ — overkill para tu escala; Coolify simple basta

## Notas operativas

- **Login lockout en memoria** funciona OK con 1 nodo. Cuando escales a >1 nodo,
  un atacante puede hacer brute-force evadiendo locks (cada nodo cuenta por separado).
  Migrar a Redis: 10 líneas, 30 min de trabajo.
- **2FA TOTP**: el campo `totpSecret` está en User pero NUNCA seteado por seed
  (todos los users tienen `totpSecret = null`). Los refunds ≥100€ fallarán con
  "TOTP not enrolled" hasta que el OWNER ejecute `pnpm cli enroll-totp` (pendiente)
  o bajemos el umbral.
- **Circuit breaker** queda definido pero no expone métricas hoy. Cuando montes
  Grafana, los eventos `open`/`half-open`/`close` ya se loguean — solo falta
  exportarlos como Prometheus counters.
