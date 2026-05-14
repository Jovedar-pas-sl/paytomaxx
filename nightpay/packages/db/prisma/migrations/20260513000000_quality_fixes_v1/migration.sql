-- =========================================================================
-- Quality fixes v1 — auditoría 2026-05-13
-- =========================================================================
-- Cambios:
--  1. earning_reversals: tabla de idempotencia para refund→earning reversal
--  2. payments.platformCommissionBps: snapshot del % plataforma por pago
--  3. payments.tipCents: propinas explícitas por cobro
--  4. payments.tipGoesTo: a quién va la propina ('operator'|'venue'|'shared')
--  5. payments.tipBeneficiaryUserId: opcional override del beneficiario
--  6. wallet_consumptions.tipCents + tipGoesTo: propinas en consumos
--  7. operator_earnings.tipCents: tracking de propinas en el earning
--  8. operator_payouts.expectedUsdtAmount + payoutFxRate: FX snapshot
--  9. CHECK constraints defensivos
-- Todos los campos nuevos son NULLABLE / DEFAULT seguros — no rompen rows existentes.
-- =========================================================================

-- 1. Tabla earning_reversals — idempotencia para refund→earning
CREATE TABLE IF NOT EXISTS "earning_reversals" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "earningId" UUID NOT NULL,
  "refundId" UUID NOT NULL,
  "reversedDeltaCents" INT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "earning_reversals_refundId_key" UNIQUE ("refundId"),
  CONSTRAINT "earning_reversals_earningId_fkey"
    FOREIGN KEY ("earningId") REFERENCES "operator_earnings"("id") ON DELETE CASCADE,
  CONSTRAINT "earning_reversals_refundId_fkey"
    FOREIGN KEY ("refundId") REFERENCES "refunds"("id") ON DELETE CASCADE,
  CONSTRAINT "earning_reversals_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "venues"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "earning_reversals_earningId_idx"
  ON "earning_reversals"("earningId");
CREATE INDEX IF NOT EXISTS "earning_reversals_tenantId_createdAt_idx"
  ON "earning_reversals"("tenantId", "createdAt" DESC);

-- 2. payments: snapshot platform commission + tip fields
ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "platformCommissionBps" INT,
  ADD COLUMN IF NOT EXISTS "tipCents" INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "tipGoesTo" TEXT,
  ADD COLUMN IF NOT EXISTS "tipBeneficiaryUserId" UUID;

-- FK suave para beneficiario (puede ser null = venue)
DO $$
BEGIN
  ALTER TABLE "payments"
    ADD CONSTRAINT "payments_tipBeneficiaryUserId_fkey"
    FOREIGN KEY ("tipBeneficiaryUserId") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CHECK: tipCents no negativo, tipGoesTo valor válido si presente
DO $$
BEGIN
  ALTER TABLE "payments"
    ADD CONSTRAINT "payments_tipCents_nonneg" CHECK ("tipCents" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "payments"
    ADD CONSTRAINT "payments_tipGoesTo_valid"
    CHECK ("tipGoesTo" IS NULL OR "tipGoesTo" IN ('operator','venue','shared','beneficiary'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3. wallet_consumptions: tipCents + tipGoesTo
ALTER TABLE "wallet_consumptions"
  ADD COLUMN IF NOT EXISTS "tipCents" INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "tipGoesTo" TEXT;

DO $$
BEGIN
  ALTER TABLE "wallet_consumptions"
    ADD CONSTRAINT "wallet_consumptions_tipCents_nonneg" CHECK ("tipCents" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "wallet_consumptions"
    ADD CONSTRAINT "wallet_consumptions_tipGoesTo_valid"
    CHECK ("tipGoesTo" IS NULL OR "tipGoesTo" IN ('operator','venue','shared'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 4. operator_earnings: tipCents tracking
ALTER TABLE "operator_earnings"
  ADD COLUMN IF NOT EXISTS "tipCents" INT NOT NULL DEFAULT 0;

DO $$
BEGIN
  ALTER TABLE "operator_earnings"
    ADD CONSTRAINT "operator_earnings_tipCents_nonneg" CHECK ("tipCents" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 5. operator_payouts: FX snapshot
ALTER TABLE "operator_payouts"
  ADD COLUMN IF NOT EXISTS "expectedAmountUsdt" NUMERIC(20,6),
  ADD COLUMN IF NOT EXISTS "payoutFxRate" NUMERIC(12,6);

-- 6. CHECK defensivo: availableAmountCents siempre en rango válido
DO $$
BEGIN
  ALTER TABLE "payments"
    ADD CONSTRAINT "payments_available_in_range"
    CHECK ("availableAmountCents" >= 0 AND "availableAmountCents" <= "amountCents" + "tipCents");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 7. Índice útil para queries de tip
CREATE INDEX IF NOT EXISTS "payments_tipBeneficiary_idx"
  ON "payments"("tipBeneficiaryUserId")
  WHERE "tipBeneficiaryUserId" IS NOT NULL;
