-- OxioParty · las casetas en lista (19-nov-2026; docs/OXIOPARTY.md): lo que ve
-- el asistente en la página de su pulsera («Casetas»): dónde está cada una
-- («Zona», 60 letras como mucho: «Junto al escenario»), qué vende («Qué
-- vende», 120: «Bocadillos, cerveza, refrescos») y si está «Abierta ahora».
-- La zona y lo que vende los pone la organización en el panel (Casetas); el
-- interruptor, la organización o el personal de esa caseta desde su app. Con
-- EDITION=club no se usan.
--
-- Columnas nulas o con un valor por defecto constante: no reescriben la tabla.
-- Cerrada de serie: que una caseta diga «Abierta» sin que nadie lo haya dicho
-- haría ir al asistente para nada. Los CHECK (ni vacías ni solo espacios),
-- NOT VALID + VALIDATE como desde 20261029. FORCE RLS sigue como la dejó
-- 20261120300000. Todo con IF NOT EXISTS: se puede repetir.

SET lock_timeout = '5s';

ALTER TABLE "stalls"
  ADD COLUMN IF NOT EXISTS "zone" VARCHAR(60),
  ADD COLUMN IF NOT EXISTS "sells" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "openNow" BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stalls_zone_check' AND conrelid = '"stalls"'::regclass) THEN
    ALTER TABLE "stalls"
      ADD CONSTRAINT "stalls_zone_check" CHECK ("zone" IS NULL OR char_length(btrim("zone")) BETWEEN 1 AND 60) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stalls_sells_check' AND conrelid = '"stalls"'::regclass) THEN
    ALTER TABLE "stalls"
      ADD CONSTRAINT "stalls_sells_check" CHECK ("sells" IS NULL OR char_length(btrim("sells")) BETWEEN 1 AND 120) NOT VALID;
  END IF;
END
$$;

ALTER TABLE "stalls" VALIDATE CONSTRAINT "stalls_zone_check";
ALTER TABLE "stalls" VALIDATE CONSTRAINT "stalls_sells_check";
