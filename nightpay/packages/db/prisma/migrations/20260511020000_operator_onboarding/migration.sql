-- Tracking de onboarding por operadora — datos personales, documentación
-- de residencia España, estado wallet/Binance, flags de ayuda necesaria,
-- y notas libres del admin.
--
-- Todos nullable para no romper operadoras existentes; defaults razonables
-- para los flags booleanos.

ALTER TABLE "users"
  -- Datos personales
  ADD COLUMN IF NOT EXISTS "phone"            TEXT,
  ADD COLUMN IF NOT EXISTS "passportCountry"  TEXT,
  ADD COLUMN IF NOT EXISTS "passportLast4"    TEXT,
  -- Documentación residencia España
  ADD COLUMN IF NOT EXISTS "hasEmpadronamiento" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "hasNie"             BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "hasTie"             BOOLEAN NOT NULL DEFAULT false,
  -- Estado wallet / Binance
  ADD COLUMN IF NOT EXISTS "walletProvider"     TEXT,
  ADD COLUMN IF NOT EXISTS "walletStatus"       TEXT,
  ADD COLUMN IF NOT EXISTS "walletTestPassed"   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "walletTestAt"       TIMESTAMPTZ,
  -- Necesidades de ayuda
  ADD COLUMN IF NOT EXISTS "needsHelpWallet"    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "needsHelpDocs"      BOOLEAN NOT NULL DEFAULT false,
  -- Estado general del onboarding
  ADD COLUMN IF NOT EXISTS "onboardingStatus"   TEXT NOT NULL DEFAULT 'NEW',
  ADD COLUMN IF NOT EXISTS "onboardingNotes"    TEXT;

-- Constraint suave para que onboardingStatus sea un enum string conocido
ALTER TABLE "users"
  DROP CONSTRAINT IF EXISTS "users_onboardingStatus_check";
ALTER TABLE "users"
  ADD CONSTRAINT "users_onboardingStatus_check"
  CHECK ("onboardingStatus" IN ('NEW', 'PROFILE_CREATED', 'INVITE_ACTIVATED', 'BINANCE_PENDING', 'READY', 'BLOCKED'));

-- Índice parcial: cuántas chicas necesitan ayuda
CREATE INDEX IF NOT EXISTS "users_needs_help_idx"
  ON "users"("tenantId")
  WHERE "role" = 'OPERATOR' AND ("needsHelpWallet" = true OR "needsHelpDocs" = true);

COMMENT ON COLUMN "users"."walletProvider" IS
  'BINANCE | BYBIT | OKX | CRYPTO_COM | TRUST_WALLET | FASTERPAY | PAYQUICKER | WISE | REVOLUT | OTHER | NONE';
COMMENT ON COLUMN "users"."walletStatus" IS
  'NOT_STARTED | REGISTERED | KYC_PENDING | KYC_VERIFIED | KYC_REJECTED';
COMMENT ON COLUMN "users"."onboardingStatus" IS
  'NEW (recién creada) → PROFILE_CREATED (alta en NightPay) → INVITE_ACTIVATED (chica fijó password) → BINANCE_PENDING (en KYC) → READY (operativa) o BLOCKED (algún problema)';
