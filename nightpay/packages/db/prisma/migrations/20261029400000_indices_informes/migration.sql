-- Índices para las consultas de cada Z, cierre automático de las 08:00,
-- resumen de las 9:00, informes, bandeja de incidencias y barrido de cobros
-- caducados (revisión total 2026-10-26, DI-02/DI-04/DI-09). Solo índices:
-- ningún dato cambia.
--
-- 1. payments por local y «momento del cobro» (reporting-sql.ts paymentAt:
--    COALESCE("authorizedAt", "createdAt")). Con (tenantId, status) Postgres
--    filtraba esa expresión fila a fila en TODO el historial pagado del local.
--    Índice de expresión: el mismo COALESCE que escriben las consultas (Z,
--    totales, por categoría, por estado, mapa del dinero, cobros sin resolver
--    de night-rules, resumen del super-admin). Sin el filtro por estado: lo
--    usan también las que miran todos los estados.
-- 2. payments abiertos por plazo (QrExpireSweepService): parcial, solo los
--    CREATED/AWAITING_CAPTURE, unas pocas filas; sin él el barrido recorría
--    el índice de qrExpiresAt de todo el historial.
-- 3. wallet_consumptions por local y fecha (consumos del Z y de los informes):
--    solo había (tenantId, walletId, createdAt) y la fecha se filtraba a mano.
-- 4. payment_events por local, tipo y fecha (bandeja de incidencias: doble
--    cobro, datáfono, aprobaciones sin dar por buenas…; ajustes del Z): solo
--    había (tenantId, occurredAt) y se descartaban los demás tipos uno a uno.
--
-- 1 y 2 no se pueden describir en schema.prisma (expresión, WHERE) y Prisma
-- no los compara (check-drift no los ve: no hacen falta en drift-allowlist);
-- schema.prisma los nombra en un comentario. 3 y 4 sí (@@index, nombre de Prisma).
--
-- Candados: CREATE INDEX (sin CONCURRENTLY: Prisma corre la migración en una
-- transacción) no deja escribir en esa tabla mientras se construye (leer, sí).
-- Medido en un Postgres 16 de pruebas con 320.000 cobros, 1,28 millones de
-- eventos y 200.000 consumos: payments ~1 s, wallet_consumptions ~0,4 s,
-- payment_events ~5 s (durante esos segundos un cobro que cambia de estado
-- espera). Despliega de día, fuera de la noche de cobro, como siempre. Si una transacción del API anterior tiene
-- la tabla, falla a los 5 s en vez de dejar en cola los cobros de detrás: se
-- marca como deshecha y se vuelve a desplegar (docs/DOKPLOY-STEPS.md, D.8).
-- Idempotente: IF NOT EXISTS en todos.
SET lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "payments_tenant_paid_at_idx"
  ON "payments" ("tenantId", (COALESCE("authorizedAt", "createdAt")));

CREATE INDEX IF NOT EXISTS "payments_open_qr_expires_idx"
  ON "payments" ("qrExpiresAt")
  WHERE "status" IN ('CREATED', 'AWAITING_CAPTURE');

CREATE INDEX IF NOT EXISTS "wallet_consumptions_tenantId_createdAt_idx"
  ON "wallet_consumptions" ("tenantId", "createdAt");

CREATE INDEX IF NOT EXISTS "payment_events_tenantId_eventType_occurredAt_idx"
  ON "payment_events" ("tenantId", "eventType", "occurredAt");
