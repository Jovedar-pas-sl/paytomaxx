-- Número impreso de la ficha NFC, único por local o por grupo (2026-10-27).
--
-- NFC = tarjeta, ficha o pulsera. El número de fábrica se repite entre lotes
-- y entre locales: ya no es único en todo el sistema (20261025000000), sino
-- dentro de su sitio, fijado al numerar la ficha:
--   «g:<grupo>» si el local es de un grupo (las fichas pasan de un local a otro
--   del grupo sin cambiar de número) o «v:<local>» si no.
-- Y sin ceros delante para buscar y comparar: «00736903» y «736903» son la
-- misma ficha. En pantalla se sigue enseñando tal cual se tecleó.
--
-- Seguro con datos: no borra ningún número. Si al quitar los ceros dos fichas
-- del mismo sitio quedan iguales, la más antigua se queda el número para
-- buscar y la otra lo conserva escrito (sin buscar por él) hasta renumerarla
-- en el panel. Idempotente. wallet_cards es pequeña: índices sin CONCURRENTLY.

-- Con el API anterior sirviendo: si una transacción suya tiene la tabla,
-- mejor fallar en 5 s (y reintentar el despliegue) que encolar sus escrituras.
SET lock_timeout = '5s';

ALTER TABLE "wallet_cards" ADD COLUMN IF NOT EXISTS "printedNumberNorm" VARCHAR(12);
ALTER TABLE "wallet_cards" ADD COLUMN IF NOT EXISTS "printedScope" TEXT;

-- Su sitio: el grupo del local donde está la ficha o, sin grupo, ese local.
UPDATE "wallet_cards" c
   SET "printedScope" = CASE WHEN v."walletGroup" IS NOT NULL THEN 'g:' || v."walletGroup" ELSE 'v:' || c."venueId"::text END
  FROM "venues" v
 WHERE v.id = c."venueId"
   AND c."printedNumber" IS NOT NULL
   AND c."printedScope" IS NULL;

-- Sin local (se borró): la ficha sola.
UPDATE "wallet_cards"
   SET "printedScope" = 'c:' || id::text
 WHERE "printedNumber" IS NOT NULL
   AND "printedScope" IS NULL;

-- Sin ceros delante («000» es «0»). Las que ya lo tienen van primero: una
-- segunda vuelta no se lo quita a nadie.
WITH ranked AS (
  SELECT id,
         COALESCE(NULLIF(ltrim("printedNumber", '0'), ''), '0') AS norm,
         row_number() OVER (
           PARTITION BY "printedScope", COALESCE(NULLIF(ltrim("printedNumber", '0'), ''), '0')
           ORDER BY ("printedNumberNorm" IS NULL), "createdAt", id
         ) AS rn
    FROM "wallet_cards"
   WHERE "printedNumber" IS NOT NULL
)
UPDATE "wallet_cards" c
   SET "printedNumberNorm" = r.norm
  FROM ranked r
 WHERE c.id = r.id
   AND r.rn = 1
   AND c."printedNumberNorm" IS NULL;

DROP INDEX IF EXISTS "wallet_cards_printedNumber_key";
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_cards_printedScope_printedNumberNorm_key"
  ON "wallet_cards" ("printedScope", "printedNumberNorm");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_cards_printedNumberNorm_digits') THEN
    ALTER TABLE "wallet_cards" ADD CONSTRAINT "wallet_cards_printedNumberNorm_digits"
      CHECK ("printedNumberNorm" IS NULL OR ("printedNumberNorm" ~ '^(0|[1-9][0-9]{0,11})$' AND "printedScope" IS NOT NULL));
  END IF;
END $$;
