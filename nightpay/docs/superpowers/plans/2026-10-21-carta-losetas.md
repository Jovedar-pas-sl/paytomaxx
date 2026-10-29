# Carta A Implementation Plan

> **For agentic workers:** Use subagent-driven-development task-by-task.

**Goal:** Ofrecer la carta y los precios confirmados, con losetas y propinas por puesto.
**Architecture:** Preset de datos compartido; aplicación autenticada al local en una transacción; operador consume el catálogo y ajustes existentes. Sin migración ni cambios automáticos de precios al desplegar.
**Tech Stack:** NestJS/Prisma, contratos Zod, React/Next, Vitest/PostgreSQL.

Diseño aprobado: [especificación](../specs/2026-10-21-carta-mapa-design.md).

## 1. Catálogo y aplicación

- [ ] Declarar los doce productos confirmados y sus precios/duraciones en contratos, sin propinas como productos vendibles solos.
- [ ] Añadir prueba roja de aplicación idempotente: segunda aplicación no duplica; otro local no cambia; matching conserva ID; sin confirmar y roles de personal rechazan; conflictos ambiguos rechazan.
- [ ] Implementar ruta de carta con roles existentes y transacción del local; bloquear el local antes de aplicar; no borrar historial ni otras entidades.
- [ ] Preview en Ajustes → Carta: productos/precios, aviso de actualización, opción conservar otros productos, resultado y errores. Aplicación explícita, nunca al montar la pantalla.
- [ ] Configurar propinas del preset mediante paymentMethodsOf: tipFlatCents [500,1000], tipFlatCentsByPost BARRA [500], SALA [500,1000]. Preservar otras formas de pago y permisos.
- [ ] Pruebas backend y de integración real para concurrencia/idempotencia y aislamiento; types API/admin.

## 2. Presentación de la carta

- [ ] Pruebas rojas de normalización de propinas por puesto y fallback global; rechazar importes inválidos.
- [ ] Extender VenuePaymentMethods con override opcional por puesto y validación/normalización; no alterar configuraciones existentes sin override.
- [ ] Consumir el override en tipTiles; probar Barra 5 y Sala 5/10 con el preset.
- [ ] Presentar duración en las losetas y etiquetas accesibles sin duplicar «1 h · 60 min».
- [ ] Conservar cuenta y cobro real con precios del servidor; verificar dos copas de 10 y tabla de 30 dan 50 €.
- [ ] Ajustar solo lo necesario de estilos para replicar las capturas; mobile sin recortes, teclado/selección accesibles.

## 3. Revisión y entrega

- [ ] Revisar contrato y endpoint/tenant/concurrencia con otro agente.
- [ ] Tipos/lint, pruebas afectadas y visual headless claro/oscuro, Barra/Sala.
- [ ] Commit y CI de la rama; no actualizar main ni desplegar sin cerrar revisión.
