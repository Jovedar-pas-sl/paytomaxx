-- Saldo bloqueado por el super-admin (2026-10-16): un saldo bloqueado no paga
-- (ni con Face ID, ni con código/ficha + PIN, ni aprobado por el encargado).
-- Se puede seguir devolviendo al cliente. Ningún estado existente servía:
-- WalletStatus es el ciclo de vida del saldo (ACTIVE/EXPIRED/REFUNDED/DEPLETED)
-- y wallet_cards.status bloquea solo una ficha.
--
-- Idempotente, columnas nullable: no toca filas existentes.
ALTER TABLE "client_wallets" ADD COLUMN IF NOT EXISTS "blockedAt" TIMESTAMPTZ;
ALTER TABLE "client_wallets" ADD COLUMN IF NOT EXISTS "blockedReason" TEXT;
