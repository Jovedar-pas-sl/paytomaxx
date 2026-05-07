-- Feature operators: chicas con saldo + comisiones + cobros propios
-- 1) Enums extendidos
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'OPERATOR';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'CANCELED';

-- 2) User: campos para operadoras + invitacion
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "commissionBps" INTEGER,
  ADD COLUMN IF NOT EXISTS "displayName"   TEXT,
  ADD COLUMN IF NOT EXISTS "invitedAt"     TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "inviteToken"   TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "users_inviteToken_key" ON "users"("inviteToken");

-- 3) Venue: tope de cobro por operadora
ALTER TABLE "venues"
  ADD COLUMN IF NOT EXISTS "operatorMaxCobroCents" INTEGER NOT NULL DEFAULT 20000;

-- 4) Payment: trazabilidad de creador
ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "createdByUserId" UUID;

ALTER TABLE "payments"
  DROP CONSTRAINT IF EXISTS "payments_createdByUserId_fkey";
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "payments_tenantId_createdByUserId_createdAt_idx"
  ON "payments"("tenantId", "createdByUserId", "createdAt" DESC);

-- 5) OperatorEarning
CREATE TABLE IF NOT EXISTS "operator_earnings" (
  "id"                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"           UUID         NOT NULL,
  "operatorId"         UUID         NOT NULL,
  "paymentId"          UUID         NOT NULL,
  "paymentAmountCents" INTEGER      NOT NULL,
  "commissionBps"      INTEGER      NOT NULL,
  "commissionCents"    INTEGER      NOT NULL,
  "reversedCents"      INTEGER      NOT NULL DEFAULT 0,
  "payoutId"           UUID,
  "createdAt"          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT "operator_earnings_paymentId_unique" UNIQUE ("paymentId"),
  CONSTRAINT "operator_earnings_tenantId_fkey"   FOREIGN KEY ("tenantId")   REFERENCES "venues"("id"),
  CONSTRAINT "operator_earnings_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "users"("id"),
  CONSTRAINT "operator_earnings_paymentId_fkey"  FOREIGN KEY ("paymentId")  REFERENCES "payments"("id")
);

CREATE INDEX IF NOT EXISTS "operator_earnings_tenant_operator_payout_idx"
  ON "operator_earnings"("tenantId", "operatorId", "payoutId");
CREATE INDEX IF NOT EXISTS "operator_earnings_tenant_operator_created_idx"
  ON "operator_earnings"("tenantId", "operatorId", "createdAt" DESC);

-- 6) OperatorPayout
CREATE TABLE IF NOT EXISTS "operator_payouts" (
  "id"           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"     UUID         NOT NULL,
  "operatorId"   UUID         NOT NULL,
  "totalCents"   INTEGER      NOT NULL,
  "paidByUserId" UUID         NOT NULL,
  "notes"        TEXT,
  "createdAt"    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT "operator_payouts_tenantId_fkey"     FOREIGN KEY ("tenantId")     REFERENCES "venues"("id"),
  CONSTRAINT "operator_payouts_operatorId_fkey"   FOREIGN KEY ("operatorId")   REFERENCES "users"("id"),
  CONSTRAINT "operator_payouts_paidByUserId_fkey" FOREIGN KEY ("paidByUserId") REFERENCES "users"("id")
);

CREATE INDEX IF NOT EXISTS "operator_payouts_tenant_operator_created_idx"
  ON "operator_payouts"("tenantId", "operatorId", "createdAt" DESC);

-- 7) FK de OperatorEarning.payoutId → OperatorPayout.id (post-create)
ALTER TABLE "operator_earnings"
  DROP CONSTRAINT IF EXISTS "operator_earnings_payoutId_fkey";
ALTER TABLE "operator_earnings"
  ADD CONSTRAINT "operator_earnings_payoutId_fkey"
  FOREIGN KEY ("payoutId") REFERENCES "operator_payouts"("id") ON DELETE SET NULL;
