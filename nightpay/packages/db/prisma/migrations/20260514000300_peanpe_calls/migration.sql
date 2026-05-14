-- =========================================================================
-- Peanpe rehecho según doc oficial v2.0
-- =========================================================================
-- Peanpe limita `identificador_llamada` a 6 caracteres alfanuméricos únicos.
-- Nuestros UUIDs de Payment son 36 chars → necesitamos tabla de mapping.
--
-- Adicional: el flujo webhook de Peanpe es challenge-response:
--   1. Peanpe POST a NightPay con identificador_llamada → devolvemos número
--      entero de 10 cifras (texto plano).
--   2. Peanpe GET a NightPay con status, msg, identificador_llamada, debug,
--      accion, seguridad — donde "seguridad" debe coincidir con el número
--      que devolvimos en paso 1.
--
-- Guardamos `securityToken` por llamada para validar el seguridad en paso 2.
-- =========================================================================

CREATE TABLE IF NOT EXISTS "peanpe_calls" (
  "identificador_llamada" TEXT PRIMARY KEY,
  "paymentId"             UUID NOT NULL UNIQUE,
  "tenantId"              UUID NOT NULL,
  "securityToken"         TEXT NOT NULL,
  "amountCents"           INT  NOT NULL,
  "resultStatus"          TEXT,
  "resultMsg"             TEXT,
  "resultReceivedAt"      TIMESTAMPTZ,
  "createdAt"             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT "peanpe_calls_paymentId_fkey"
    FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE CASCADE,
  CONSTRAINT "peanpe_calls_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "venues"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "peanpe_calls_paymentId_idx"
  ON "peanpe_calls"("paymentId");
CREATE INDEX IF NOT EXISTS "peanpe_calls_tenantId_createdAt_idx"
  ON "peanpe_calls"("tenantId", "createdAt" DESC);

-- CHECK: identificador_llamada exactamente 1-6 chars alfanuméricos.
DO $$
BEGIN
  ALTER TABLE "peanpe_calls"
    ADD CONSTRAINT "peanpe_calls_id_length"
    CHECK (LENGTH("identificador_llamada") >= 1 AND LENGTH("identificador_llamada") <= 6
           AND "identificador_llamada" ~ '^[A-Za-z0-9]+$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
