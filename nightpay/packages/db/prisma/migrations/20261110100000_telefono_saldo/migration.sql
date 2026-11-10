-- Teléfono opcional del cliente al darle una ficha nueva (estudio de fichas,
-- 10-nov-2026): solo para encontrar su saldo si lo pierde todo (la ficha y el
-- código). Es un dato personal: no sale en ninguna lista; lo ven el encargado
-- y el dueño en el detalle del saldo y lo buscan por él. Se guarda normalizado
-- (cifras, con «+» delante si es internacional), entre 6 y 15 cifras.
--
-- Columna nueva y vacía (sin valor por defecto: no reescribe la tabla) y su
-- CHECK con NOT VALID + VALIDATE (no bloquea las escrituras mientras mira).
-- Se puede repetir.

SET lock_timeout = '5s';

ALTER TABLE "client_wallets" ADD COLUMN IF NOT EXISTS "contactPhone" VARCHAR(16);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_wallets_contact_phone_format') THEN
    ALTER TABLE "client_wallets"
      ADD CONSTRAINT "client_wallets_contact_phone_format"
      CHECK ("contactPhone" IS NULL OR "contactPhone" ~ '^[+]?[0-9]{6,15}$') NOT VALID;
  END IF;
END $$;

ALTER TABLE "client_wallets" VALIDATE CONSTRAINT "client_wallets_contact_phone_format";
