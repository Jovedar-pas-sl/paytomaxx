-- Saldo con PIN, sin el móvil del cliente: la chica encuentra el saldo por su
-- código o su pulsera NFC y el cliente teclea su PIN de 4 cifras.
-- pinHash: HMAC con clave del servidor + scrypt (nunca en claro).
ALTER TABLE "client_wallets" ADD COLUMN IF NOT EXISTS "pinHash" TEXT;
-- 5 fallos seguidos → bloqueado hasta que lo desbloquee el encargado.
ALTER TABLE "client_wallets" ADD COLUMN IF NOT EXISTS "pinFails" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "client_wallets" ADD COLUMN IF NOT EXISTS "pinLockedAt" TIMESTAMPTZ;
-- Número de serie de la pulsera/tarjeta NFC (mayúsculas, sin separadores).
ALTER TABLE "client_wallets" ADD COLUMN IF NOT EXISTS "nfcTag" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "client_wallets_nfcTag_key" ON "client_wallets" ("nfcTag");
