-- Revisión 2026-10-15 (#13): un código de autorización del ticket confirma un
-- solo cobro por datáfono y día.
--
-- La API ya lo comprueba (24 h) dentro de la transacción que marca el cobro
-- pagado, de uno en uno por datáfono y código; este índice es la red en la
-- base por si dos confirmaciones se cruzan. Solo cobros confirmados a mano por
-- el camarero (POS_EXTERNAL sin número de operación): los del datáfono PAX ya
-- son únicos por su número de operación, y los resueltos a mano de Redsys no
-- entran.
--
-- Idempotente y sin tocar datos: si ya hubiera códigos repetidos el mismo día
-- en el mismo datáfono (de antes de este arreglo), NO se crea y se avisa;
-- revísalos y crea el índice a mano con la misma sentencia.

-- La columna la crea scripts/db-heal.ts después de las migraciones; en una
-- base nueva aún no existe.
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "captureMethod" TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "payments"
     WHERE "captureMethod" = 'POS_EXTERNAL'
       AND "authCode" IS NOT NULL
       AND "posOperationNumber" IS NULL
       AND "authorizedAt" IS NOT NULL
     GROUP BY "terminalId", "authCode", (("authorizedAt" AT TIME ZONE 'UTC')::date)
    HAVING COUNT(*) > 1
  ) THEN
    RAISE WARNING 'payments_pos_authcode_day_key NO creado: hay códigos de autorización repetidos el mismo día en el mismo datáfono. Revísalos y créalo a mano (migración 20261015020000).';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS "payments_pos_authcode_day_key"
      ON "payments" ("terminalId", "authCode", (("authorizedAt" AT TIME ZONE 'UTC')::date))
      WHERE "captureMethod" = 'POS_EXTERNAL'
        AND "authCode" IS NOT NULL
        AND "posOperationNumber" IS NULL
        AND "authorizedAt" IS NOT NULL;
  END IF;
END $$;
