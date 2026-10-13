-- Fase 0 (2026-10-13) — cerrar agujeros de cobro.
--
-- 1) Datos que manda el banco en cada cobro aprobado (método, tarjeta,
--    autorización). Hasta ahora solo quedaban en webhook_deliveries.rawBody.
-- 2) payment_attempts: cada intento de pago es un pedido Redsys distinto.
--    Permite reintentar con otra tarjeta sin "pedido repetido" (SIS0051) y
--    seguir encontrando el pago aunque llegue el aviso de un intento viejo.
-- 3) earning_reversals.afterPayout: una devolución que llega cuando la
--    comisión ya se pagó a la chica queda como deuda y se descuenta del
--    siguiente pago (settledPayoutId = el pago que la descontó).

-- Backfills sin filtro de tenant.
SET LOCAL app.bypass_rls = 'on';

-- ─── 1) Datos del banco en payments ──────────────────────────────────────
ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "payMethodCode" TEXT,
  ADD COLUMN IF NOT EXISTS "cardBrand"     TEXT,
  ADD COLUMN IF NOT EXISTS "cardType"      TEXT,
  ADD COLUMN IF NOT EXISTS "cardCountry"   TEXT,
  ADD COLUMN IF NOT EXISTS "cardLast4"     TEXT,
  ADD COLUMN IF NOT EXISTS "authCode"      TEXT,
  ADD COLUMN IF NOT EXISTS "secure3ds"     BOOLEAN,
  ADD COLUMN IF NOT EXISTS "authorizedAt"  TIMESTAMPTZ;

-- ─── 2) Intentos de pago ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "payment_attempts" (
  "id"           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "paymentId"    UUID        NOT NULL REFERENCES "payments"("id") ON DELETE CASCADE,
  "tenantId"     UUID        NOT NULL,
  "provider"     "Provider"  NOT NULL,
  "providerTxId" TEXT        NOT NULL,
  -- PENDING | APPROVED | DENIED
  "status"       TEXT        NOT NULL DEFAULT 'PENDING',
  "responseCode" TEXT,
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "payment_attempts_provider_providerTxId_key"
  ON "payment_attempts" ("provider", "providerTxId");
CREATE INDEX IF NOT EXISTS "payment_attempts_paymentId_createdAt_idx"
  ON "payment_attempts" ("paymentId", "createdAt" DESC);

-- El intento vigente de cada pago ya enviado a una pasarela.
INSERT INTO "payment_attempts" ("paymentId", "tenantId", "provider", "providerTxId", "status", "createdAt", "updatedAt")
SELECT p."id", p."tenantId", p."provider", p."providerTxId",
       CASE WHEN p."status" IN ('AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED') THEN 'APPROVED' ELSE 'PENDING' END,
       p."updatedAt", p."updatedAt"
  FROM "payments" p
 WHERE p."provider" IS NOT NULL
   AND p."providerTxId" IS NOT NULL
ON CONFLICT DO NOTHING;

-- ─── 3) Devoluciones después de pagar a la chica ─────────────────────────
ALTER TABLE "earning_reversals"
  ADD COLUMN IF NOT EXISTS "afterPayout"     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "settledPayoutId" UUID;

CREATE INDEX IF NOT EXISTS "earning_reversals_open_debt_idx"
  ON "earning_reversals" ("earningId")
  WHERE "afterPayout" AND "settledPayoutId" IS NULL;
