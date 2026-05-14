-- Categorización de cobros + comisiones configurables por venue+categoría.
--
-- revenueCategory permite separar contablemente:
--   CHICA_SERVICE: servicio profesional de la chica (ej. tiempo, compañía)
--   VENUE_BAR    : bebidas / copas vendidas por el local
--   VENUE_ROOM   : alquiler de habitación
--   VENUE_FOOD   : cocina / comida
--   EXTRA        : otros / mixto sin categorizar
--
-- operatorCommissionDefaults es un JSON con la comisión por defecto en bps
-- para CADA categoría en ESTE venue. Permite override granular sin tocar código.
-- Ej: { "CHICA_SERVICE": 9000, "VENUE_BAR": 0, "VENUE_ROOM": 0, "VENUE_FOOD": 0, "EXTRA": 0 }
-- User.commissionBps sigue funcionando: si está set en la chica, OVERRIDE el
-- default de venue para CHICA_SERVICE (las VENUE_* siempre usan venue default).

-- ─── Payment.revenueCategory ──────────────────────────────────────────────
ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "revenueCategory" TEXT;

-- Backfill: cobros existentes se marcan según patrón
--   - walletId NULL + createdBy es OPERATOR → CHICA_SERVICE (era el flujo default)
--   - walletId set (top-up) → EXTRA (no podemos saber a posteriori)
--   - el resto → EXTRA
UPDATE "payments"
   SET "revenueCategory" = CASE
     WHEN "walletId" IS NULL AND "createdByUserId" IS NOT NULL THEN 'CHICA_SERVICE'
     ELSE 'EXTRA'
   END
 WHERE "revenueCategory" IS NULL;

-- Defaultea futuros INSERTs sin revenueCategory a 'EXTRA' (validación en app)
ALTER TABLE "payments"
  ALTER COLUMN "revenueCategory" SET DEFAULT 'EXTRA';

ALTER TABLE "payments"
  ALTER COLUMN "revenueCategory" SET NOT NULL;

-- CHECK constraint para limitar valores válidos (defensa en DB además de app)
ALTER TABLE "payments"
  DROP CONSTRAINT IF EXISTS payments_revenue_category_valid;
ALTER TABLE "payments"
  ADD CONSTRAINT payments_revenue_category_valid
  CHECK ("revenueCategory" IN ('CHICA_SERVICE', 'VENUE_BAR', 'VENUE_ROOM', 'VENUE_FOOD', 'EXTRA'));

-- Index para Z-report (split por categoría en tenant + ventana de tiempo)
CREATE INDEX IF NOT EXISTS payments_tenant_category_created_idx
  ON "payments"("tenantId", "revenueCategory", "createdAt");

-- ─── Venue.operatorCommissionDefaults ─────────────────────────────────────
ALTER TABLE "venues"
  ADD COLUMN IF NOT EXISTS "operatorCommissionDefaults" JSONB;

-- Default seed para venues existentes: chica 90% en su servicio, 0% en venue_*
UPDATE "venues"
   SET "operatorCommissionDefaults" = '{
     "CHICA_SERVICE": 9000,
     "VENUE_BAR": 0,
     "VENUE_ROOM": 0,
     "VENUE_FOOD": 0,
     "EXTRA": 0
   }'::jsonb
 WHERE "operatorCommissionDefaults" IS NULL;

ALTER TABLE "venues"
  ALTER COLUMN "operatorCommissionDefaults" SET DEFAULT '{
    "CHICA_SERVICE": 9000,
    "VENUE_BAR": 0,
    "VENUE_ROOM": 0,
    "VENUE_FOOD": 0,
    "EXTRA": 0
  }'::jsonb;

ALTER TABLE "venues"
  ALTER COLUMN "operatorCommissionDefaults" SET NOT NULL;
