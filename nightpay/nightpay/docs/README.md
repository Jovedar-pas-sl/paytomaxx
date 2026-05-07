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
- **[runbooks/](runbooks/)** — Procedimientos operativos P0/P1:
  - [P0 Pagos atascados](runbooks/P0-pagos-atascados.md)
  - [P0 Pasarela caída](runbooks/P0-pasarela-caida.md)
  - [P1 WS degradados](runbooks/P1-ws-degradado.md)
  - [P1 DB sobrecargada](runbooks/P1-db-overload.md)
- **[checklists/onboarding-local.md](checklists/onboarding-local.md)** — Onboarding de nuevos venues.
- **[diagrams/](diagrams/)** — Diagramas exportados (Mermaid → PNG, opcional).

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
