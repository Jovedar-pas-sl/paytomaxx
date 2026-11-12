-- «Pagar con bitcoin» (BTCPay Server), 14-nov-2026: la conexión de cada local a
-- su BTCPay (btcpay_stores) y las facturas de bitcoin de los cobros
-- (btcpay_invoices). Dos tablas nuevas: no tocan nada que ya exista y no
-- bloquean el arranque. La clave de API y el secreto del aviso se guardan
-- CIFRADOS (la clave de cifrado no está en la base). FORCE RLS en las dos.
-- Se puede repetir.

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "btcpay_stores" (
  "id"               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"         UUID        NOT NULL REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "baseUrl"          TEXT        NOT NULL,
  "storeId"          TEXT        NOT NULL,
  "apiKeyEnc"        TEXT        NOT NULL,
  "webhookSecretEnc" TEXT,
  "webhookId"        TEXT,
  "hookToken"        TEXT        NOT NULL,
  "enabled"          BOOLEAN     NOT NULL DEFAULT false,
  "purpose"          TEXT        NOT NULL DEFAULT 'BOTH',
  "lastCheckAt"      TIMESTAMPTZ,
  "lastCheckOk"      BOOLEAN,
  "lastCheckMessage" TEXT,
  "createdAt"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "btcpay_stores_purpose_known" CHECK ("purpose" IN ('PAYMENTS', 'TOPUPS', 'BOTH'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "btcpay_stores_tenantId_key" ON "btcpay_stores" ("tenantId");
CREATE UNIQUE INDEX IF NOT EXISTS "btcpay_stores_hookToken_key" ON "btcpay_stores" ("hookToken");

CREATE TABLE IF NOT EXISTS "btcpay_invoices" (
  "id"               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"         UUID        NOT NULL REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "paymentId"        UUID        NOT NULL REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "invoiceId"        TEXT        NOT NULL,
  "storeId"          TEXT        NOT NULL,
  "status"           TEXT        NOT NULL DEFAULT 'New',
  "additionalStatus" TEXT,
  "amountCents"      INTEGER     NOT NULL,
  "amountBtc"        TEXT,
  "rate"             TEXT,
  "checkoutLink"     TEXT        NOT NULL,
  "qrLink"           TEXT        NOT NULL,
  "chainAddress"     TEXT,
  "expiresAt"        TIMESTAMPTZ NOT NULL,
  "closedAt"         TIMESTAMPTZ,
  "lastCheckedAt"    TIMESTAMPTZ,
  "createdAt"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "btcpay_invoices_status_known" CHECK ("status" IN ('New', 'Processing', 'Settled', 'Expired', 'Invalid')),
  CONSTRAINT "btcpay_invoices_amount_positive" CHECK ("amountCents" > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "btcpay_invoices_invoiceId_key" ON "btcpay_invoices" ("invoiceId");
CREATE INDEX IF NOT EXISTS "btcpay_invoices_tenantId_idx" ON "btcpay_invoices" ("tenantId");
CREATE INDEX IF NOT EXISTS "btcpay_invoices_paymentId_idx" ON "btcpay_invoices" ("paymentId");
-- Una sola factura abierta por cobro (dos «Pagar con bitcoin» a la vez no abren dos).
CREATE UNIQUE INDEX IF NOT EXISTS "btcpay_invoices_one_open_per_payment"
  ON "btcpay_invoices" ("paymentId") WHERE "status" IN ('New', 'Processing');

ALTER TABLE "btcpay_stores" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "btcpay_stores" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS btcpay_stores_tenant_isolation ON "btcpay_stores";
CREATE POLICY btcpay_stores_tenant_isolation ON "btcpay_stores"
  USING ((SELECT app_rls_bypass()) OR "tenantId" = (SELECT app_current_tenant()))
  WITH CHECK ((SELECT app_rls_bypass()) OR "tenantId" = (SELECT app_current_tenant()));

ALTER TABLE "btcpay_invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "btcpay_invoices" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS btcpay_invoices_tenant_isolation ON "btcpay_invoices";
CREATE POLICY btcpay_invoices_tenant_isolation ON "btcpay_invoices"
  USING ((SELECT app_rls_bypass()) OR "tenantId" = (SELECT app_current_tenant()))
  WITH CHECK ((SELECT app_rls_bypass()) OR "tenantId" = (SELECT app_current_tenant()));
