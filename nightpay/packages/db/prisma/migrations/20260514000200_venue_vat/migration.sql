-- =========================================================================
-- Venue IVA config — para Modelo 303 trimestral
-- =========================================================================
--  - vatBps: basis points del tipo IVA (2100 = 21%, 1000 = 10%, 400 = 4%)
--  - vatRegime: GENERAL | RECARGO_EQUIVALENCIA | EXENTO
--
-- Realismo: hostelería tiene tipos mixtos (21% bebidas alcohólicas + 10%
-- comida/habitaciones). Phase 1 simplifica con un único tipo dominante por
-- venue. Si el admin necesita desglose granular, futuro Sprint añade
-- `category_vat` table.
-- =========================================================================

ALTER TABLE "venues"
  ADD COLUMN IF NOT EXISTS "vatBps" INT NOT NULL DEFAULT 2100,
  ADD COLUMN IF NOT EXISTS "vatRegime" TEXT NOT NULL DEFAULT 'GENERAL';

-- CHECK: vatBps en rango razonable (0 = exento, máx 27% para casos extremos)
DO $$
BEGIN
  ALTER TABLE "venues"
    ADD CONSTRAINT "venues_vatBps_range" CHECK ("vatBps" >= 0 AND "vatBps" <= 2700);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "venues"
    ADD CONSTRAINT "venues_vatRegime_valid"
    CHECK ("vatRegime" IN ('GENERAL','RECARGO_EQUIVALENCIA','EXENTO'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
