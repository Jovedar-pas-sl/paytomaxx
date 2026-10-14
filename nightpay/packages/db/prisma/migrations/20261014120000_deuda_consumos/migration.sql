-- Deuda de la chica también cuando se anula un consumo del saldo que ya se le
-- había pagado (antes solo con devoluciones del banco): earning_reversals
-- admite un consumo como origen en lugar de una devolución.
ALTER TABLE "earning_reversals" ALTER COLUMN "refundId" DROP NOT NULL;
ALTER TABLE "earning_reversals"
  ADD COLUMN IF NOT EXISTS "consumptionId" UUID REFERENCES "wallet_consumptions"("id") ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS "earning_reversals_consumptionId_key"
  ON "earning_reversals" ("consumptionId");
ALTER TABLE "earning_reversals" DROP CONSTRAINT IF EXISTS "earning_reversals_source_check";
ALTER TABLE "earning_reversals"
  ADD CONSTRAINT "earning_reversals_source_check" CHECK ("refundId" IS NOT NULL OR "consumptionId" IS NOT NULL);
