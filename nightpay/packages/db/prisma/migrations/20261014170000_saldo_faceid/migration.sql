-- Saldo con Face ID: el cliente paga desde su móvil desbloqueándolo como
-- siempre (Face ID, huella o el PIN del teléfono: lo decide su móvil). Aquí
-- solo la clave pública de esa llave (passkey); no sirve para pagar.
CREATE TABLE IF NOT EXISTS "wallet_passkeys" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "walletId"     UUID NOT NULL REFERENCES "client_wallets" ("id") ON DELETE CASCADE,
  "credentialId" TEXT NOT NULL,
  "publicKey"    BYTEA NOT NULL,
  "counter"      BIGINT NOT NULL DEFAULT 0,
  "transports"   TEXT[] NOT NULL DEFAULT '{}',
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "lastUsedAt"   TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_passkeys_credentialId_key" ON "wallet_passkeys" ("credentialId");
CREATE INDEX IF NOT EXISTS "wallet_passkeys_walletId_idx" ON "wallet_passkeys" ("walletId");

-- Cobro del saldo con QR: la chica lo crea sin saber de quién es el saldo;
-- se ata al saldo cuando el cliente lo paga con su Face ID.
ALTER TABLE "wallet_charge_requests" ALTER COLUMN "walletId" DROP NOT NULL;
ALTER TABLE "wallet_charge_requests" ADD COLUMN IF NOT EXISTS "payToken" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_charge_requests_payToken_key" ON "wallet_charge_requests" ("payToken");

-- Recarga sumada al saldo que el cliente ya tenía (con su Face ID).
ALTER TABLE "client_wallets" ADD COLUMN IF NOT EXISTS "mergedIntoId" UUID REFERENCES "client_wallets" ("id");
CREATE INDEX IF NOT EXISTS "client_wallets_mergedIntoId_idx" ON "client_wallets" ("mergedIntoId");
