-- Devolver en efectivo los pagos con bitcoin (17-nov-2026), parte 2: el
-- bitcoin que llegó SIN cobro (tarde, dos veces o a medias en un cobro que no
-- se pagó) y se devolvió en efectivo. Una sola devolución por factura (índice
-- único). Tabla nueva: no toca nada que ya exista. FORCE RLS como las demás.
-- Se puede repetir.

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "btc_cash_returns" (
  "id"                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"          UUID        NOT NULL REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "paymentId"         UUID        NOT NULL REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "invoiceId"         TEXT        NOT NULL,
  "amountCents"       INTEGER     NOT NULL,
  "reason"            TEXT        NOT NULL,
  "receiptCode"       TEXT        NOT NULL,
  "requestedById"     UUID        NOT NULL,
  "paidById"          UUID        NOT NULL,
  "approvalRequestId" UUID,
  "createdAt"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Cada devolución en efectivo, por debajo de 1.000 € (Ley 7/2012).
  CONSTRAINT "btc_cash_returns_amount_range" CHECK ("amountCents" > 0 AND "amountCents" < 100000)
);

CREATE UNIQUE INDEX IF NOT EXISTS "btc_cash_returns_invoiceId_key" ON "btc_cash_returns" ("invoiceId");
CREATE INDEX IF NOT EXISTS "btc_cash_returns_tenantId_createdAt_idx" ON "btc_cash_returns" ("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "btc_cash_returns_paymentId_idx" ON "btc_cash_returns" ("paymentId");

ALTER TABLE "btc_cash_returns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "btc_cash_returns" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS btc_cash_returns_tenant_isolation ON "btc_cash_returns";
CREATE POLICY btc_cash_returns_tenant_isolation ON "btc_cash_returns"
  USING ((SELECT app_rls_bypass()) OR "tenantId" = (SELECT app_current_tenant()))
  WITH CHECK ((SELECT app_rls_bypass()) OR "tenantId" = (SELECT app_current_tenant()));
