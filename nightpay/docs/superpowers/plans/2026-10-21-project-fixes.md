# Project Review Fixes Implementation Plan

> **For agentic workers:** Use subagent-driven-development for independent domains and review each result before integration. No shared staging or commits from workers.

**Goal:** Corregir los cuatro bloques aprobados conservando el comportamiento financiero y de permisos existente.
**Architecture:** Cambios acotados en el monolito actual, autorización común de consulta, intenciones idempotentes y transacciones por local; verificaciones reproducibles con contratos y herramientas existentes.
**Tech Stack:** NestJS/Fastify, Prisma/PostgreSQL, Redis/BullMQ, Zod, React/Next, Vitest/Playwright, Bash y GitHub Actions.

Diseño: `../specs/2026-10-21-project-fixes-design.md`. Evidencia: `../../reviews/2026-10-21/REVISION-GLOBAL-MEJORAS.md`.

## Bloque 1 · Seguridad

- [ ] Prueba roja HTTP de wallet con passkey: `/state`, endpoint público antiguo y Google Wallet sin cookie rechazan; con cookie válida permiten; wallet sin passkey conserva activación. Crear guard compartido en `apps/api/src/modules/wallets/wallet-view.guard.ts`, aplicarlo a las rutas alternativas y registrarlo en `wallets.module.ts`. Ejecutar pruebas de controladores/HTTP y rutas sin prefijo.
- [ ] Añadir carrera roja de `qrToken` regenerado a `wallet-card-view.service.spec.ts`. Comparar versión/enlace original tras verificar y rechazar el cambio. Mantener bloqueo/reasignación y saldo cero.
- [ ] Añadir regresiones de superadmin para sesión ausente/caducada/revocada, anterior a promoción y MFA desactivada. Reutilizar servicios de sesión y prueba MFA del login; no aceptar solo el flag actual. Mantener acceso entre locales y step-up en escrituras.
- [ ] Revisión de requisitos y calidad; tipos/lint/API afectada. Commit del bloque.

## Bloque 2 · Dinero

- [ ] En `wallet-cash-topup.service.ts`, probar clave repetida con destino distinto, igual destino, creación y wallet fusionada. Guardar/comparar huella de intención; migración aditiva si es necesaria, 409 ante cambio, recibo idéntico ante repetición.
- [ ] En `bank-recon.service.ts`/`bank-match.ts`, conservar terminal y probar dos operaciones 77 de distintos terminales, mismo/distinto importe y CSV invertido. Rechazar emparejamiento ambiguo y cubrir devoluciones/anulaciones relacionadas.
- [ ] En contratos/controlador/servicio de refunds y endpoint admin, clave estable por intención, reserva única y recuperación de resultado. Prueba roja de respuesta perdida y solicitudes concurrentes; no confundir repetición con dos devoluciones deliberadas.
- [ ] En `refund-reversal-sweep.service.ts`, prueba de primer lote con fallos persistentes y progreso hacia siguientes. Reintento escalonado/rotación segura y métricas de antigüedad.
- [ ] Integración real aislada, regresiones y revisión antes del commit de dinero.

## Bloque 3 · Recuperación y despliegue

- [ ] `scripts/restore-check.sh`: reproducir restauración parcial; fallar por error inesperado y validar esquema mínimo. Pruebas de guion con herramientas simuladas, sin base real del usuario.
- [ ] `MetricsService`/colas: alimentar backlog y antigüedad reales; corregir agregaciones de alertas. Pruebas sintéticas de productor y reglas.
- [ ] Docker/health/panel: identificar automáticamente revisión construida. Probar valor generado y fallback explícitamente desconocido; conservar flujo Git → Deploy sin introducir pasos manuales por versión.
- [ ] Ensayo y revisión; commit de operación.

## Bloque 4 · Pantallas y pruebas

- [ ] `MyCobros`/helpers: prueba de más de 50 filas y actualización de una antigua; revalidar las páginas cargadas, controlar carreras y conservar paginación sin duplicados.
- [ ] `money-map-view`/`MoneyMapPanel`: pruebas de saldo real frente a variación negativa y Z histórico; etiquetas/frescura correctas, selector desde/hasta usando API actual, sin cambios en cálculos; comprobar móvil y teclado.
- [ ] Carta: prevalidación y aplicación transaccional por local con los 13 productos actuales, IDs/historial preservados y conflictos explícitos. Prueba de dos administradores simultáneos y fallo atómico. UI mantiene vista previa y rutas existentes para edición individual.
- [ ] Playwright: fixture y servicios aislados, login real, carta/total y guardas de consulta; incluir suite estable en CI con capturas/trazas al fallar. Pruebas físicas de NFC/Face ID quedan separadas del simulador.
- [ ] Tipos/lint, integración y suites finales, revisión independiente, commit y CI de rama. Registrar evidencia y SHA preparado para despliegue.
