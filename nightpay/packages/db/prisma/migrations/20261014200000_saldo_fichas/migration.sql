-- Ficha NFC del saldo (NTAG213/215/216): lleva grabado un enlace con un código
-- al azar (?ficha=...). Dice de qué saldo es; para pagar, el cliente pone su
-- PIN. Una ficha se puede dar a otro cliente cuando el saldo anterior se acaba.
CREATE TABLE IF NOT EXISTS "wallet_cards" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "token"      TEXT NOT NULL,
  -- Número de serie (si se leyó con un Android): una copia en otra ficha no vale.
  "uid"        TEXT,
  "walletId"   UUID REFERENCES "client_wallets" ("id") ON DELETE SET NULL,
  -- ACTIVE | BLOCKED (perdida: ya no paga).
  "status"     TEXT NOT NULL DEFAULT 'ACTIVE',
  "linkedById" UUID,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "linkedAt"   TIMESTAMPTZ,
  "blockedAt"  TIMESTAMPTZ,
  "lastUsedAt" TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_cards_token_key" ON "wallet_cards" ("token");
CREATE INDEX IF NOT EXISTS "wallet_cards_walletId_idx" ON "wallet_cards" ("walletId");
-- Una ficha activa por saldo (dos "dar ficha" a la vez no dejan dos).
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_cards_one_active_per_wallet"
  ON "wallet_cards" ("walletId") WHERE "status" = 'ACTIVE' AND "walletId" IS NOT NULL;
