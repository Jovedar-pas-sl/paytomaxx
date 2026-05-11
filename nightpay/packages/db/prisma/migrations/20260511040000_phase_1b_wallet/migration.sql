-- Phase 1B — Client wallet (cash-in-advance closed-loop)
-- Legal vía EMD2 art. 1.5(k): saldo limitado a la red del emisor, sin
-- convertirse en cash, refund solo a tarjeta original.
--
-- Idempotente: usa IF NOT EXISTS / IF EXISTS para poder re-aplicarse tras
-- recovery parcial sin error.

-- 1) Enum WalletStatus
DO $$ BEGIN
  CREATE TYPE "WalletStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REFUNDED', 'DEPLETED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2) Tabla client_wallets
CREATE TABLE IF NOT EXISTS "client_wallets" (
  "id"           UUID         NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"    UUID         NOT NULL,
  "identifier"  TEXT,
  "balanceCents" INTEGER      NOT NULL DEFAULT 0,
  "status"      "WalletStatus" NOT NULL DEFAULT 'ACTIVE',
  "expiresAt"   TIMESTAMPTZ,
  "qrToken"     TEXT         NOT NULL,
  "createdAt"   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT "client_wallets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "client_wallets_qrToken_key" UNIQUE ("qrToken"),
  CONSTRAINT "client_wallets_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "venues"("id") ON DELETE RESTRICT,
  CONSTRAINT "client_wallets_balance_nonneg" CHECK ("balanceCents" >= 0)
);

CREATE INDEX IF NOT EXISTS "client_wallets_tenant_status_idx"
  ON "client_wallets"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "client_wallets_tenant_identifier_idx"
  ON "client_wallets"("tenantId", "identifier");
CREATE INDEX IF NOT EXISTS "client_wallets_tenant_created_idx"
  ON "client_wallets"("tenantId", "createdAt" DESC);

COMMENT ON TABLE "client_wallets" IS
  'Phase 1B closed-loop prepaid wallets. Cliente carga UN saldo al entrar al venue, consume durante la noche, refund al cierre.';

-- 3) Tabla wallet_consumptions
CREATE TABLE IF NOT EXISTS "wallet_consumptions" (
  "id"               UUID         NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"         UUID         NOT NULL,
  "walletId"         UUID         NOT NULL,
  "amountCents"      INTEGER      NOT NULL,
  "providedByUserId" UUID         NOT NULL,
  "category"         TEXT         NOT NULL,
  "notes"            TEXT,
  "idempotencyKey"   TEXT,
  "reversedAt"       TIMESTAMPTZ,
  "reversedByUserId" UUID,
  "createdAt"        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT "wallet_consumptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wallet_consumptions_tenant_idempotency_key"
    UNIQUE ("tenantId", "idempotencyKey"),
  CONSTRAINT "wallet_consumptions_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "venues"("id") ON DELETE RESTRICT,
  CONSTRAINT "wallet_consumptions_walletId_fkey"
    FOREIGN KEY ("walletId") REFERENCES "client_wallets"("id") ON DELETE RESTRICT,
  CONSTRAINT "wallet_consumptions_providedByUserId_fkey"
    FOREIGN KEY ("providedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "wallet_consumptions_reversedByUserId_fkey"
    FOREIGN KEY ("reversedByUserId") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "wallet_consumptions_amount_positive" CHECK ("amountCents" > 0)
);

CREATE INDEX IF NOT EXISTS "wallet_consumptions_wallet_created_idx"
  ON "wallet_consumptions"("tenantId", "walletId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "wallet_consumptions_provider_created_idx"
  ON "wallet_consumptions"("tenantId", "providedByUserId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "wallet_consumptions_category_idx"
  ON "wallet_consumptions"("tenantId", "category");

-- 4) payments — walletId nullable + index
DO $$ BEGIN
  ALTER TABLE "payments"
    ADD COLUMN "walletId" UUID,
    ADD CONSTRAINT "payments_walletId_fkey"
      FOREIGN KEY ("walletId") REFERENCES "client_wallets"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "payments_walletId_idx" ON "payments"("walletId");

-- 5) operator_earnings — relax paymentId NOT NULL + add consumptionId

-- Drop legacy unique constraint (puede tener nombre _key o _unique según historial)
ALTER TABLE "operator_earnings"
  DROP CONSTRAINT IF EXISTS "operator_earnings_paymentId_key";

-- Make paymentId nullable (no-op si ya es nullable)
ALTER TABLE "operator_earnings"
  ALTER COLUMN "paymentId" DROP NOT NULL;

-- Add consumptionId column si no existe
DO $$ BEGIN
  ALTER TABLE "operator_earnings"
    ADD COLUMN "consumptionId" UUID,
    ADD CONSTRAINT "operator_earnings_consumptionId_fkey"
      FOREIGN KEY ("consumptionId") REFERENCES "wallet_consumptions"("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Re-add unique partial indexes (idempotente)
CREATE UNIQUE INDEX IF NOT EXISTS "operator_earnings_paymentId_unique"
  ON "operator_earnings"("paymentId")
  WHERE "paymentId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "operator_earnings_consumptionId_unique"
  ON "operator_earnings"("consumptionId")
  WHERE "consumptionId" IS NOT NULL;

-- XOR check (drop si existe + add fresh)
ALTER TABLE "operator_earnings"
  DROP CONSTRAINT IF EXISTS "operator_earnings_source_xor";
ALTER TABLE "operator_earnings"
  ADD CONSTRAINT "operator_earnings_source_xor"
  CHECK (
    ("paymentId" IS NOT NULL AND "consumptionId" IS NULL)
    OR
    ("paymentId" IS NULL AND "consumptionId" IS NOT NULL)
  );

-- 6) RLS para nuevas tablas
ALTER TABLE "client_wallets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "wallet_consumptions" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "client_wallets_tenant_isolation" ON "client_wallets"
    USING ("tenantId" = current_setting('app.current_tenant_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE POLICY "wallet_consumptions_tenant_isolation" ON "wallet_consumptions"
    USING ("tenantId" = current_setting('app.current_tenant_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
