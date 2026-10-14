-- El saldo, atado al móvil del cliente (no hay forma de leer la MAC: cada
-- móvil lleva una llave aleatoria en su navegador y aquí solo su huella).
CREATE TABLE IF NOT EXISTS "client_devices" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tokenHash"  TEXT NOT NULL,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "lastSeenAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "client_devices_tokenHash_key" ON "client_devices" ("tokenHash");

-- Face ID / huella de ese móvil (WebAuthn): solo la clave pública.
CREATE TABLE IF NOT EXISTS "client_device_passkeys" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "deviceId"     UUID NOT NULL REFERENCES "client_devices" ("id") ON DELETE CASCADE,
  "credentialId" TEXT NOT NULL,
  "publicKey"    BYTEA NOT NULL,
  "counter"      BIGINT NOT NULL DEFAULT 0,
  "transports"   TEXT[] NOT NULL DEFAULT '{}',
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "lastUsedAt"   TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS "client_device_passkeys_credentialId_key" ON "client_device_passkeys" ("credentialId");
CREATE INDEX IF NOT EXISTS "client_device_passkeys_deviceId_idx" ON "client_device_passkeys" ("deviceId");

-- De qué móvil es cada saldo (el primero que lo abre).
ALTER TABLE "client_wallets"
  ADD COLUMN IF NOT EXISTS "deviceId" UUID REFERENCES "client_devices" ("id") ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "client_wallets_deviceId_idx" ON "client_wallets" ("deviceId");
