-- Revisión 2026-10-15 (#13): la credencial del datáfono PAX se puede rotar
-- (POST /v1/pos-device/rotate) y puede caducar si se configura
-- POS_DEVICE_TOKEN_MAX_AGE_DAYS (por defecto no caduca).
--
-- deviceTokenNextHash: la credencial nueva, que convive con la anterior hasta
-- que el datáfono la usa por primera vez. deviceTokenIssuedAt: desde cuándo
-- vale la credencial en uso. Idempotente y sin tocar datos existentes salvo
-- rellenar la fecha de las ya entregadas (la de la vinculación).

ALTER TABLE "terminals" ADD COLUMN IF NOT EXISTS "deviceTokenNextHash" TEXT;
ALTER TABLE "terminals" ADD COLUMN IF NOT EXISTS "deviceTokenIssuedAt" TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS "terminals_deviceTokenNextHash_key"
  ON "terminals" ("deviceTokenNextHash");

UPDATE "terminals"
   SET "deviceTokenIssuedAt" = "devicePairedAt"
 WHERE "deviceTokenIssuedAt" IS NULL
   AND "deviceTokenHash" IS NOT NULL;
