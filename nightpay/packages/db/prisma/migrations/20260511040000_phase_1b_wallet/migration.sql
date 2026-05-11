-- Phase 1B — Client wallet (cash-in-advance closed-loop)
-- Legal vía EMD2 art. 1.5(k): saldo limitado a la red del emisor, sin
-- convertirse en cash, refund solo a tarjeta original.

-- 1) Enum WalletStatus
CREATE TYPE "WalletStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REFUNDED', 'DEPLETED');

-- 2) Tabla client_wallets
CREATE TABLE "client_wallets" (
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
  -- Balance no puede ir negativo a nivel de DB (defense in depth)
  CONSTRAINT "client_wallets_balance_nonneg" CHECK ("balanceCents" >= 0)
);

CREATE INDEX "client_wallets_tenant_status_idx"
  ON "client_wallets"("tenantId", "status");
CREATE INDEX "client_wallets_tenant_identifier_idx"
  ON "client_wallets"("tenantId", "identifier");
CREATE INDEX "client_wallets_tenant_created_idx"
  ON "client_wallets"("tenantId", "createdAt" DESC);

COMMENT ON TABLE "client_wallets" IS
  'Phase 1B closed-loop prepaid wallets. Cliente carga UN saldo al entrar al venue, consume durante la noche, refund al cierre.';
COMMENT ON COLUMN "client_wallets"."identifier" IS
  'Phone/email/anon hash opcional. El qrToken es lo que identifica la wallet en runtime.';
COMMENT ON COLUMN "client_wallets"."expiresAt" IS
  'Null = no expira mientras ACTIVE. Set cuando admin convierte balance restante en crédito futuro.';

-- 3) Tabla wallet_consumptions
CREATE TABLE "wallet_consumptions" (
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

CREATE INDEX "wallet_consumptions_wallet_created_idx"
  ON "wallet_consumptions"("tenantId", "walletId", "createdAt" DESC);
CREATE INDEX "wallet_consumptions_provider_created_idx"
  ON "wallet_consumptions"("tenantId", "providedByUserId", "createdAt" DESC);
CREATE INDEX "wallet_consumptions_category_idx"
  ON "wallet_consumptions"("tenantId", "category");

COMMENT ON TABLE "wallet_consumptions" IS
  'Cada consumo de balance de un ClientWallet. Si providedBy.role=OPERATOR genera OperatorEarning paralelo.';

-- 4) payments — walletId nullable + index
ALTER TABLE "payments"
  ADD COLUMN "walletId" UUID,
  ADD CONSTRAINT "payments_walletId_fkey"
    FOREIGN KEY ("walletId") REFERENCES "client_wallets"("id") ON DELETE SET NULL;

CREATE INDEX "payments_walletId_idx" ON "payments"("walletId");

COMMENT ON COLUMN "payments"."walletId" IS
  'Phase 1B: si set, este Payment es el top-up de la ClientWallet referenciada. Al AUTHORIZED se suma al balance atómicamente.';

-- 5) operator_earnings — relax paymentId NOT NULL + add consumptionId
-- IMPORTANTE: hay un @unique en paymentId que toca recrear para permitir nulls.

-- Drop legacy unique constraint
ALTER TABLE "operator_earnings"
  DROP CONSTRAINT IF EXISTS "operator_earnings_paymentId_key";

-- Make paymentId nullable
ALTER TABLE "operator_earnings"
  ALTER COLUMN "paymentId" DROP NOT NULL;

-- Add consumptionId
ALTER TABLE "operator_earnings"
  ADD COLUMN "consumptionId" UUID,
  ADD CONSTRAINT "operator_earnings_consumptionId_fkey"
    FOREIGN KEY ("consumptionId") REFERENCES "wallet_consumptions"("id") ON DELETE RESTRICT;

-- Re-add @unique but as partial (NULL is OK in unique with partial index)
CREATE UNIQUE INDEX "operator_earnings_paymentId_unique"
  ON "operator_earnings"("paymentId")
  WHERE "paymentId" IS NOT NULL;
CREATE UNIQUE INDEX "operator_earnings_consumptionId_unique"
  ON "operator_earnings"("consumptionId")
  WHERE "consumptionId" IS NOT NULL;

-- CRITICAL XOR check: exactamente UNO de paymentId/consumptionId set.
ALTER TABLE "operator_earnings"
  ADD CONSTRAINT "operator_earnings_source_xor"
  CHECK (
    ("paymentId" IS NOT NULL AND "consumptionId" IS NULL)
    OR
    ("paymentId" IS NULL AND "consumptionId" IS NOT NULL)
  );

COMMENT ON CONSTRAINT "operator_earnings_source_xor" ON "operator_earnings" IS
  'Cada earning viene de un Payment (cobro QR directo) o WalletConsumption (Phase 1B), nunca ambos ni ninguno.';

-- 6) RLS para nuevas tablas — mismo patrón que las existentes
ALTER TABLE "client_wallets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "wallet_consumptions" ENABLE ROW LEVEL SECURITY;

-- Policy: app-level filter via Prisma middleware (CLS-injected tenantId).
-- DB-level fallback: deny todo si no hay tenant set. Producción usa role
-- "nightpay_app" que tiene esta config.
CREATE POLICY "client_wallets_tenant_isolation" ON "client_wallets"
  USING ("tenantId" = current_setting('app.current_tenant_id', true)::uuid);
CREATE POLICY "wallet_consumptions_tenant_isolation" ON "wallet_consumptions"
  USING ("tenantId" = current_setting('app.current_tenant_id', true)::uuid);
