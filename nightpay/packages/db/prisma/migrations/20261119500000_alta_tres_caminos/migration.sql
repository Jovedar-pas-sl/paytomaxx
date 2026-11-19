-- Alta de la compañera con tres caminos de cobro (19-nov-2026). Columnas
-- nuevas en "users":
--   legalName                nombre legal completo, CIFRADO (pa1:..., AES-256-GCM
--                            con ENCRYPTION_KEK, como la cuenta de cobro)
--   birthDate                fecha de nacimiento (con menos de 18 años no se
--                            activa la cuenta)
--   payoutHolderConfirmedAt  el dueño confirmó que la cuenta es suya aunque el
--                            titular no coincida con su nombre legal
--   oxiocardStatus           la OxioCard: NO_SOLICITADA (de fábrica),
--                            SOLICITADA, EN_VERIFICACION, APROBADA, RECHAZADA
--   oxiocardStatusAt         último cambio de ese estado
--
-- Las que no tienen valor por defecto quedan NULL; la de la OxioCard lleva un
-- valor fijo (en Postgres 16 no reescribe la tabla). El CHECK se añade NOT
-- VALID y se valida después. Se puede repetir.

SET lock_timeout = '5s';

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "legalName" TEXT,
  ADD COLUMN IF NOT EXISTS "birthDate" DATE,
  ADD COLUMN IF NOT EXISTS "payoutHolderConfirmedAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "oxiocardStatus" TEXT NOT NULL DEFAULT 'NO_SOLICITADA',
  ADD COLUMN IF NOT EXISTS "oxiocardStatusAt" TIMESTAMPTZ;

DO $$
BEGIN
  ALTER TABLE "users"
    ADD CONSTRAINT "users_oxiocard_status_check"
    CHECK ("oxiocardStatus" IN ('NO_SOLICITADA', 'SOLICITADA', 'EN_VERIFICACION', 'APROBADA', 'RECHAZADA')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
-- La columna es nueva (todas con el valor de fábrica): validarla es inmediato.
ALTER TABLE "users" VALIDATE CONSTRAINT "users_oxiocard_status_check";
