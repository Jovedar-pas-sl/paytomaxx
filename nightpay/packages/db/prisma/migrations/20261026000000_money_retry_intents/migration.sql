-- Additive: legacy requests retain their existing semantics (NULL intention).
ALTER TABLE wallet_cash_topups ADD COLUMN "intentFingerprint" TEXT;
ALTER TABLE refunds
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "intentFingerprint" TEXT,
  ADD COLUMN "replayResponse" JSONB,
  ADD COLUMN "earningReversalRetryAt" TIMESTAMPTZ;
CREATE UNIQUE INDEX "refunds_tenantId_idempotencyKey_key" ON refunds("tenantId", "idempotencyKey");
