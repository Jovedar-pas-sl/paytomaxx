-- «Cargar saldo antes de llegar» (2026-10-30, apps/api/src/modules/home-topup).
--
-- El dueño enciende en Ajustes → Formas de cobro «Cargar saldo desde casa» y
-- recibe un enlace del local (/r/<código>) y su QR para publicarlo (Instagram,
-- la web, WhatsApp). Con él, cualquiera carga un saldo nuevo de ese local (o
-- recarga el que ya tiene ese navegador) y lo paga con Apple Pay, Google Pay o
-- tarjeta, como cualquier recarga con tarjeta.
--
--   venues "homeTopUpEnabled"  el interruptor; apagado de serie (también en los
--                              locales de antes): el enlace da 404.
--   venues "homeTopUpCode"     el código del enlace: 12 bytes al azar en
--                              base64url (16 letras). Nunca el id ni nada que
--                              se pueda adivinar o recorrer. «Enlace nuevo»
--                              lo cambia: el de antes deja de funcionar.
--                              Único entre locales.
--
-- Columnas nuevas con valor por defecto constante (o NULL): en Postgres 11+ no
-- reescriben la tabla y el API anterior (start-first) sigue funcionando sin
-- ellas. El índice único es sobre venues (pocas filas): un momento.
-- Los CHECK, NOT VALID y después VALIDATE (todas las filas tienen ya los
-- valores por defecto, que los cumplen). Idempotente.

SET lock_timeout = '5s';

ALTER TABLE "venues"
  ADD COLUMN IF NOT EXISTS "homeTopUpEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "homeTopUpCode" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "venues_homeTopUpCode_key" ON "venues"("homeTopUpCode");

-- Reglas en la base:
--  - el código tiene la forma de los que crea el API (16 letras de base64url);
--  - encendido ⇒ con código (el API lo crea al encender).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'venues_home_topup_code_check') THEN
    ALTER TABLE "venues"
      ADD CONSTRAINT "venues_home_topup_code_check"
      CHECK ("homeTopUpCode" IS NULL OR "homeTopUpCode" ~ '^[A-Za-z0-9_-]{16}$') NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'venues_home_topup_enabled_check') THEN
    ALTER TABLE "venues"
      ADD CONSTRAINT "venues_home_topup_enabled_check"
      CHECK (NOT "homeTopUpEnabled" OR "homeTopUpCode" IS NOT NULL) NOT VALID;
  END IF;
END
$$;

ALTER TABLE "venues" VALIDATE CONSTRAINT "venues_home_topup_code_check";
ALTER TABLE "venues" VALIDATE CONSTRAINT "venues_home_topup_enabled_check";
