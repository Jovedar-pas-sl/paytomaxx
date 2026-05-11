-- Phase 1A — Multi-rail payout routing
-- Permite registrar el método de cobro preferido por cada operadora
-- (cripto on-chain, e-wallet, banco offshore, wallet LatAm, cash manual)
-- y persistir referencia de la transacción real + estado de reconciliación
-- por cada OperatorPayout.

-- 1) Campos de routing del payout en User (solo aplica a role=OPERATOR)
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "payoutMethod"   TEXT,
  ADD COLUMN IF NOT EXISTS "payoutAddress"  TEXT,
  ADD COLUMN IF NOT EXISTS "payoutMetadata" JSONB,
  ADD COLUMN IF NOT EXISTS "payoutLabel"    TEXT;

COMMENT ON COLUMN "users"."payoutMethod" IS
  'Rail de payout preferido por la chica. Valores soportados Phase 1: USDT_TRC20, USDT_BEP20, USDC_POLY, USDC_SOL, BINANCE_PAY_ID, OKX_INTERNAL, BYBIT_INTERNAL, FASTERPAY_EMAIL, PAYQUICKER_EMAIL, HYPERWALLET_TOKEN, REVOLUT_TAG, PAYONEER_EMAIL, SEPA_IBAN, WIRE_INTERNATIONAL, MERCADOPAGO_CVU, PIX_KEY, NEQUI_PHONE, DAVIPLATA_PHONE, MANUAL_CASH. Null = no configurado.';
COMMENT ON COLUMN "users"."payoutAddress" IS
  'Address/email/IBAN/teléfono/CVU según payoutMethod. Validado por la app (regex).';
COMMENT ON COLUMN "users"."payoutMetadata" IS
  'Datos extra: {bankName, swiftBic, country, accountHolder...} para wires SWIFT.';

-- 2) Campos de reconciliación + referencia externa en OperatorPayout
ALTER TABLE "operator_payouts"
  ADD COLUMN IF NOT EXISTS "externalTxId"          TEXT,
  ADD COLUMN IF NOT EXISTS "externalRail"          TEXT,
  ADD COLUMN IF NOT EXISTS "reconciliationStatus"  TEXT NOT NULL DEFAULT 'UNRECONCILED',
  ADD COLUMN IF NOT EXISTS "receiptUrl"            TEXT,
  ADD COLUMN IF NOT EXISTS "reconciledAt"          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "reconciledByUserId"    UUID;

-- FK del reconciledBy hacia users (admin que confirmó)
ALTER TABLE "operator_payouts"
  DROP CONSTRAINT IF EXISTS "operator_payouts_reconciledByUserId_fkey";
ALTER TABLE "operator_payouts"
  ADD CONSTRAINT "operator_payouts_reconciledByUserId_fkey"
  FOREIGN KEY ("reconciledByUserId") REFERENCES "users"("id") ON DELETE SET NULL;

-- Índices: reconciliación nocturna recorre WHERE reconciliationStatus='UNRECONCILED'
CREATE INDEX IF NOT EXISTS "operator_payouts_recon_status_idx"
  ON "operator_payouts"("tenantId", "reconciliationStatus")
  WHERE "reconciliationStatus" = 'UNRECONCILED';

-- Constraint suave: reconciliationStatus es un enum string conocido
ALTER TABLE "operator_payouts"
  DROP CONSTRAINT IF EXISTS "operator_payouts_recon_status_check";
ALTER TABLE "operator_payouts"
  ADD CONSTRAINT "operator_payouts_recon_status_check"
  CHECK ("reconciliationStatus" IN ('UNRECONCILED', 'MATCHED', 'MANUAL_OK', 'MISMATCH'));

COMMENT ON COLUMN "operator_payouts"."externalTxId" IS
  'Hash on-chain (USDT/USDC), receipt ID (e-wallet), SEPA reference, etc. Set por el admin al marcar pagado.';
COMMENT ON COLUMN "operator_payouts"."externalRail" IS
  'Rail efectivo usado (copia de User.payoutMethod en el momento del pago).';
COMMENT ON COLUMN "operator_payouts"."reconciliationStatus" IS
  'UNRECONCILED (default), MATCHED (verificado on-chain auto), MANUAL_OK (admin confirma manualmente), MISMATCH (verificación falló).';
COMMENT ON COLUMN "operator_payouts"."receiptUrl" IS
  'URL opcional al screenshot/PDF del receipt subido por el admin (S3/R2).';
