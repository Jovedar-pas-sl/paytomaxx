-- Número de la ficha NFC (2026-10-24): «Ficha nº 0522» en la recepción.
--
-- NFC = tarjeta, ficha o pulsera: todas llevan su número. Es de la ficha (no
-- del saldo) y para siempre: una ficha que vuelve al stock y sale otra vez
-- conserva el suyo. Uno solo para todos los locales (una ficha puede pasar a
-- otro local del grupo sin cambiar de número); la pantalla lo enseña con
-- cuatro cifras (0522).
--
-- Las que ya existen se numeran por orden de alta; las nuevas, al crearse
-- (secuencia). wallet_cards es pequeña: el índice se crea sin CONCURRENTLY.
-- Idempotente: se puede lanzar dos veces sin cambiar nada la segunda.

-- Con el API anterior sirviendo: si una transacción suya tiene la tabla,
-- mejor fallar en 5 s (y reintentar el despliegue) que encolar sus escrituras.
SET lock_timeout = '5s';

CREATE SEQUENCE IF NOT EXISTS "wallet_cards_number_seq" AS INTEGER;

ALTER TABLE "wallet_cards" ADD COLUMN IF NOT EXISTS "number" INTEGER;

-- Las que ya existen, por orden de alta (detrás de las que ya tengan número).
WITH base AS (SELECT COALESCE(MAX("number"), 0) AS top FROM "wallet_cards"),
     todo AS (
       SELECT id, row_number() OVER (ORDER BY "createdAt", id) AS rn
         FROM "wallet_cards"
        WHERE "number" IS NULL
     )
UPDATE "wallet_cards" c
   SET "number" = base.top + todo.rn
  FROM base, todo
 WHERE c.id = todo.id;

-- La siguiente, detrás de la última (con la tabla vacía, la 1).
SELECT setval(
  '"wallet_cards_number_seq"',
  GREATEST((SELECT COALESCE(MAX("number"), 0) FROM "wallet_cards"), 1),
  (SELECT COUNT(*) > 0 FROM "wallet_cards")
);

ALTER TABLE "wallet_cards" ALTER COLUMN "number" SET DEFAULT nextval('"wallet_cards_number_seq"');
ALTER TABLE "wallet_cards" ALTER COLUMN "number" SET NOT NULL;
ALTER SEQUENCE "wallet_cards_number_seq" OWNED BY "wallet_cards"."number";

CREATE UNIQUE INDEX IF NOT EXISTS "wallet_cards_number_key" ON "wallet_cards" ("number");
