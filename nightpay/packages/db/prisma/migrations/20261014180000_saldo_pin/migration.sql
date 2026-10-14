-- PIN del saldo: además de Face ID, el cliente puede pagar sin sacar el móvil
-- tecleando su PIN de 4 cifras en el móvil de la chica (con su código; más
-- adelante, su tarjeta). pinHash: HMAC con clave del servidor + scrypt.
ALTER TABLE "client_wallets" ADD COLUMN IF NOT EXISTS "pinHash" TEXT;
-- 5 fallos seguidos → bloqueado hasta que lo desbloquee el encargado.
ALTER TABLE "client_wallets" ADD COLUMN IF NOT EXISTS "pinFails" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "client_wallets" ADD COLUMN IF NOT EXISTS "pinLockedAt" TIMESTAMPTZ;
-- Los fallos viejos caducan (12 h): un despiste semanas después no bloquea.
ALTER TABLE "client_wallets" ADD COLUMN IF NOT EXISTS "pinFailedAt" TIMESTAMPTZ;
-- Quién del personal puso el PIN sin el cliente delante (el encargado, porque
-- lo olvidó): esa persona no puede cobrar con él (hacen falta dos).
ALTER TABLE "client_wallets" ADD COLUMN IF NOT EXISTS "pinSetById" UUID;
