-- Recibos idempotentes de las salidas con NFC + PIN. No cambia devoluciones anteriores.
SET lock_timeout = '5s';
ALTER TABLE wallet_payouts ADD COLUMN IF NOT EXISTS "requestKey" TEXT;
ALTER TABLE wallet_payouts ADD COLUMN IF NOT EXISTS "remainingBalanceCents" INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_payouts_tenantId_requestKey_key"
  ON wallet_payouts ("tenantId", "requestKey");
