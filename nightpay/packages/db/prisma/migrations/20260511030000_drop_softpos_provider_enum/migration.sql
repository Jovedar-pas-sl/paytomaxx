-- Limpieza post-revert SoftPOS (Phase 1C descartada).
-- El enum Provider tenía VIVA_SOFTPOS y STRIPE_TAP pero el código y las uniones
-- TS se revirtieron en 41f274b. Ya no hay filas usando estos valores (verificado).

-- PostgreSQL no permite DROP de enum values directamente — toca recrear el tipo.
-- Estrategia segura:
--   1. Crear enum nuevo
--   2. Cambiar columnas a TEXT (transitoria)
--   3. Renombrar enums
--   4. Cambiar columnas al enum nuevo
--   5. Drop enum viejo

CREATE TYPE "Provider_new" AS ENUM ('WIPAY', 'PEANPE');

ALTER TABLE "gateway_credentials" ALTER COLUMN "provider" TYPE TEXT;
ALTER TABLE "payments" ALTER COLUMN "provider" TYPE TEXT;

ALTER TYPE "Provider" RENAME TO "Provider_old";
ALTER TYPE "Provider_new" RENAME TO "Provider";

ALTER TABLE "gateway_credentials" ALTER COLUMN "provider" TYPE "Provider" USING ("provider"::"Provider");
ALTER TABLE "payments" ALTER COLUMN "provider" TYPE "Provider" USING ("provider"::"Provider");

DROP TYPE "Provider_old";
