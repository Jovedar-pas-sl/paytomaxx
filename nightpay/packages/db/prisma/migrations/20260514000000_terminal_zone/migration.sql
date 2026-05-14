-- =========================================================================
-- Track A — Terminal extendido para red de PAX A920 Pro por zona
-- =========================================================================
-- Cambios:
--  1. terminals.zone: agrupador físico (BARRA/HABITACIONES/MESAS/OTRO + custom)
--  2. terminals.hardwareModel: PAX_A920_PRO | OTRO (futuro)
--  3. terminals.deviceSerial: S/N físico (futuro lookup Paytef)
--  4. Índice tenant+zone para queries de routing por zona
-- Todos los campos nuevos son NULLABLE — backwards compat.
-- =========================================================================

ALTER TABLE "terminals"
  ADD COLUMN IF NOT EXISTS "zone" TEXT,
  ADD COLUMN IF NOT EXISTS "hardwareModel" TEXT,
  ADD COLUMN IF NOT EXISTS "deviceSerial" TEXT;

CREATE INDEX IF NOT EXISTS "terminals_tenantId_zone_idx"
  ON "terminals"("tenantId", "zone");

-- CHECK suave: si zone NO es OTRO, debe coincidir con enum predefinido.
-- Aceptamos cualquier string si zone=NULL o si valor custom (admin libre).
-- No imponemos enum estricto a nivel DB para permitir 'OTRO/<custom>'.

-- Backfill opcional (idempotente): clasifica terminales legacy por label.
UPDATE "terminals" SET "zone" = 'BARRA'
  WHERE "zone" IS NULL AND "label" ILIKE 'BARRA%';
UPDATE "terminals" SET "zone" = 'MESAS'
  WHERE "zone" IS NULL AND "label" ILIKE 'MESA%';
