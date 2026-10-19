# NightPay Docs

Documentación técnica de NightPay, plataforma de cobro híbrida QR + NFC para ocio nocturno.

## Contenido

- **[MASTER_PLAN_V2.md](MASTER_PLAN_V2.md)** — Documento maestro (18 secciones). Punto de entrada.
- **[adr/](adr/)** — Architecture Decision Records:
  - [ADR-001 Socket.io + Redis adapter](adr/ADR-001-socketio-redis-adapter.md)
  - [ADR-002 Multi-tenancy app + RLS](adr/ADR-002-multitenancy-app-rls.md)
  - [ADR-003 XState FSM + saga](adr/ADR-003-xstate-saga-pagos.md)
  - [ADR-004 Particionado `payment_events`](adr/ADR-004-particionado-payment-events.md)
  - [ADR-005 Adapter pasarelas + circuit breaker](adr/ADR-005-adapter-pasarelas-circuit-breaker.md)
- **[DOKPLOY-STEPS.md](DOKPLOY-STEPS.md)** — Despliegue vigente (Dokploy + Cloudflare). `DEPLOYMENT.md` está obsoleto.
- **[BACKUPS.md](BACKUPS.md)** — Copias de seguridad, segunda copia con restic y prueba de restauración.
- **[PUESTA-EN-MARCHA.md](PUESTA-EN-MARCHA.md)** — Telegram, cuadre con el banco, seguridad del servidor.
- **[SESION-PERSONAL.md](SESION-PERSONAL.md)** — Sesión del personal en cookie HttpOnly: qué notan, `AUTH_BODY_REFRESH_UNTIL` y reglas CSRF.
- **[runbooks/](runbooks/)** — Qué hacer cuando algo falla:
  - [P0 Cobros atascados](runbooks/P0-pagos-atascados.md)
  - [P0 Pasarela caída](runbooks/P0-pasarela-caida.md)
  - [P0 VPS perdido](runbooks/P0-vps-perdido.md)
  - [P1 Pantallas sin tiempo real](runbooks/P1-ws-degradado.md)
  - [P1 Base de datos lenta o caída](runbooks/P1-db-overload.md)
- **[postmortems/TEMPLATE.md](postmortems/TEMPLATE.md)** — Plantilla para después de un incidente.
- **[checklists/onboarding-local.md](checklists/onboarding-local.md)** — Onboarding de nuevos venues.

Dónde mirar cuando algo va mal: `https://api.<dominio>/v1/health` (estado de
API, base y Redis; lo vigila el monitor externo → Telegram), panel →
**Incidencias** (y sus alertas de Telegram), Dokploy → servicio → **Logs**, y
`/v1/metrics` con `METRICS_TOKEN`.

## Cómo leer este set

1. Empezar por **MASTER_PLAN_V2 §1 Resumen ejecutivo**.
2. Escanear **§2 Escenarios** para entender qué debe funcionar.
3. Saltar a la sección relevante según rol:
   - Ingeniero nuevo: §3 arquitectura → §5 datos → §6 backend → §8 pagos.
   - DevOps: §12 observabilidad → §13 resiliencia → §15 deploy → runbooks.
   - Manager operativo: §16 runbooks + checklist onboarding.
4. ADRs al abordar un área específica — explican el *por qué* de las decisiones clave.

## Generar versión .docx (opcional)

Requiere [pandoc](https://pandoc.org/installing.html) instalado.

```bash
pandoc MASTER_PLAN_V2.md -o MASTER_PLAN_V2.docx --from markdown --toc --standalone
```

## Versión

v2.0 — 2026-04-21. Ver §18.4 del master plan para historial.

## Principio rector

**Ejecutable, no teórico.** Cada sección termina con "Criterios de aceptación verificables".
El doc no se considera completo si algún criterio no pasa.
