-- Noche fácil (2026-10-23).
--
--  1. venues.nightSettings: ajustes de la noche del local (NFC sin PIN hasta
--     un importe y un tope por noche, teclado del PIN, importes rápidos y
--     cobro por defecto de la recepción, vibración y sonido). NULL = lo de
--     fábrica (packages/contracts/src/night-settings.ts).
--  2. wallet_consumptions.authMethod: cómo se autorizó cada consumo del
--     saldo: nfc_nopin (el NFC solo) | pin | passkey (Face ID) | staff (el
--     encargado, sin el cliente). NULL = consumos de antes.
--     Índice (walletId, createdAt): lo gastado sin PIN esta noche por saldo.
--  3. client_wallets.noPinResetAt: último PIN bueno; lo gastado sin PIN se
--     cuenta desde aquí (o desde las 08:00 de Madrid, lo más tarde).
--  4. client_wallets.pendingAssignAt / pendingAssignById: recarga cobrada
--     desde Inicio sin leer antes el NFC del cliente («pendiente de
--     asignar»): el dinero está en un saldo propio hasta que se suma al del
--     cliente (al acercar su NFC o teclear su código). Nunca se pierde.
--
-- Idempotente y sin tocar filas existentes (columnas nullable).

-- Corre con el API anterior sirviendo (start-first): si una transacción suya
-- tiene la tabla, mejor fallar a los 5 s (el deploy se repite) que dejar
-- todas las escrituras en cola detrás de este ALTER.
SET lock_timeout = '5s';

-- ─── 1. Ajustes de la noche ─────────────────────────────────────────────

ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "nightSettings" JSONB;

ALTER TABLE "venues" DROP CONSTRAINT IF EXISTS "venues_night_settings_is_object";
ALTER TABLE "venues" ADD CONSTRAINT "venues_night_settings_is_object"
  CHECK ("nightSettings" IS NULL OR jsonb_typeof("nightSettings") = 'object');

-- ─── 2. Cómo se autorizó cada consumo ───────────────────────────────────

ALTER TABLE "wallet_consumptions" ADD COLUMN IF NOT EXISTS "authMethod" TEXT;

ALTER TABLE "wallet_consumptions" DROP CONSTRAINT IF EXISTS "wallet_consumptions_auth_method";
ALTER TABLE "wallet_consumptions" ADD CONSTRAINT "wallet_consumptions_auth_method"
  CHECK ("authMethod" IS NULL OR "authMethod" IN ('nfc_nopin', 'pin', 'passkey', 'staff'));

CREATE INDEX IF NOT EXISTS "wallet_consumptions_walletId_createdAt_idx"
  ON "wallet_consumptions" ("walletId", "createdAt");

-- ─── 3 y 4. Saldo: último PIN bueno y recarga pendiente de asignar ──────

ALTER TABLE "client_wallets" ADD COLUMN IF NOT EXISTS "noPinResetAt" TIMESTAMPTZ;
ALTER TABLE "client_wallets" ADD COLUMN IF NOT EXISTS "pendingAssignAt" TIMESTAMPTZ;
ALTER TABLE "client_wallets" ADD COLUMN IF NOT EXISTS "pendingAssignById" UUID;
