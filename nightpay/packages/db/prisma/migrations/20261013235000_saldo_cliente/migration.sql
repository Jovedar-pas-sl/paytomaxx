-- Saldo NightPay (2026-10-13) — rediseño de la wallet del cliente.
--
--  - El cliente tiene su saldo en el móvil (enlace /w/...) con un código corto
--    que enseña a la chica: nada de elegir wallets de una lista por etiqueta.
--  - Cada gasto lo acepta el cliente en su móvil (solicitud de cobro).
--  - El saldo vale en todos los locales del mismo grupo (mismo dueño).
--  - Al irse, el saldo se le devuelve a la tarjeta (hecho en BBVA) o en
--    efectivo, y queda apuntado.

-- Grupo de locales: todos los locales actuales son del mismo dueño.
ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "walletGroup" TEXT;
UPDATE "venues" SET "walletGroup" = 'principal' WHERE "walletGroup" IS NULL;

ALTER TABLE "client_wallets"
  ADD COLUMN IF NOT EXISTS "shortCode"        TEXT,
  ADD COLUMN IF NOT EXISTS "walletGroup"      TEXT,
  ADD COLUMN IF NOT EXISTS "closeRequestedAt" TIMESTAMPTZ;

UPDATE "client_wallets" w
   SET "walletGroup" = v."walletGroup"
  FROM "venues" v
 WHERE v."id" = w."tenantId" AND w."walletGroup" IS NULL;

-- Código para las wallets activas que ya existían: el mismo alfabeto que los
-- nuevos (sin 0/O ni 1/I/L, que se confunden). La referencia a w."id" hace que
-- la subconsulta se evalúe por fila (si no, todas tendrían el mismo código).
UPDATE "client_wallets" w
   SET "shortCode" = (
         SELECT string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + floor(random() * 31)::int, 1), '')
           FROM generate_series(1, 6)
          WHERE w."id" IS NOT NULL
       )
 WHERE w."shortCode" IS NULL AND w."status" = 'ACTIVE';

-- El código identifica una wallet activa (puede repetirse en las ya cerradas).
CREATE UNIQUE INDEX IF NOT EXISTS "client_wallets_shortCode_active_key"
  ON "client_wallets" ("shortCode")
  WHERE "status" = 'ACTIVE' AND "shortCode" IS NOT NULL;

-- Solicitudes de cobro que el cliente acepta o rechaza en su móvil.
-- tenantId = local donde se cobra (puede no ser el de la recarga).
CREATE TABLE IF NOT EXISTS "wallet_charge_requests" (
  "id"                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"          UUID        NOT NULL REFERENCES "venues"("id") ON DELETE CASCADE,
  "walletId"          UUID        NOT NULL REFERENCES "client_wallets"("id") ON DELETE CASCADE,
  "requestedByUserId" UUID        NOT NULL,
  "amountCents"       INTEGER     NOT NULL CHECK ("amountCents" > 0),
  "category"          TEXT        NOT NULL,
  "serviceName"       TEXT,
  "status"            TEXT        NOT NULL DEFAULT 'PENDING',
  "expiresAt"         TIMESTAMPTZ NOT NULL,
  "decidedAt"         TIMESTAMPTZ,
  "consumptionId"     UUID,
  "createdAt"         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "wallet_charge_requests_walletId_status_idx"
  ON "wallet_charge_requests" ("walletId", "status");
CREATE INDEX IF NOT EXISTS "wallet_charge_requests_tenantId_createdAt_idx"
  ON "wallet_charge_requests" ("tenantId", "createdAt" DESC);

-- Devoluciones del saldo al cliente que se va (tarjeta o efectivo).
CREATE TABLE IF NOT EXISTS "wallet_payouts" (
  "id"            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"      UUID        NOT NULL REFERENCES "venues"("id") ON DELETE CASCADE,
  "walletId"      UUID        NOT NULL REFERENCES "client_wallets"("id") ON DELETE CASCADE,
  "amountCents"   INTEGER     NOT NULL CHECK ("amountCents" > 0),
  "method"        TEXT        NOT NULL CHECK ("method" IN ('CARD', 'CASH')),
  "bankReference" TEXT,
  "note"          TEXT,
  "paidByUserId"  UUID        NOT NULL,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "wallet_payouts_tenantId_createdAt_idx"
  ON "wallet_payouts" ("tenantId", "createdAt" DESC);

-- ENABLE sin FORCE, como el resto (20260502000000_soften_rls_force).
ALTER TABLE "wallet_charge_requests" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wallet_charge_requests_tenant_isolation ON "wallet_charge_requests";
CREATE POLICY wallet_charge_requests_tenant_isolation ON "wallet_charge_requests"
  USING (app_rls_bypass() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_rls_bypass() OR "tenantId" = app_current_tenant());

ALTER TABLE "wallet_payouts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wallet_payouts_tenant_isolation ON "wallet_payouts";
CREATE POLICY wallet_payouts_tenant_isolation ON "wallet_payouts"
  USING (app_rls_bypass() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_rls_bypass() OR "tenantId" = app_current_tenant());
