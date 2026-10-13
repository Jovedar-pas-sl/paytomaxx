-- Cuadre con el banco (2026-10-14).
--
-- El dueño sube el fichero de operaciones del portal de BBVA/Redsys (TPV
-- virtual) o de Paytef (datáfonos) y se compara, línea a línea, con lo que
-- hay apuntado: lo que el banco cobró y aquí no consta como pagado, lo que
-- aquí consta como pagado y el banco no tiene, importes distintos y
-- devoluciones hechas en un lado y no en el otro. Lo que no cuadra sale en
-- Incidencias.

-- Un fichero subido. tenantId = local desde el que se sube; el cuadre cubre
-- los locales de su grupo (mismo comercio en el banco).
CREATE TABLE IF NOT EXISTS "bank_statements" (
  "id"               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"         UUID        NOT NULL REFERENCES "venues"("id") ON DELETE CASCADE,
  "source"           TEXT        NOT NULL CHECK ("source" IN ('REDSYS', 'PAYTEF')),
  "fileName"         TEXT        NOT NULL,
  "fileSha256"       TEXT        NOT NULL,
  "periodFrom"       DATE        NOT NULL,
  "periodTo"         DATE        NOT NULL,
  "rowsTotal"        INTEGER     NOT NULL,
  "matchedCount"     INTEGER     NOT NULL,
  "problemCount"     INTEGER     NOT NULL,
  "bankTotalCents"   INTEGER     NOT NULL,
  "oursTotalCents"   INTEGER     NOT NULL,
  "uploadedByUserId" UUID        NOT NULL,
  -- Otro fichero posterior cubre todos sus días: este deja de contar.
  "supersededAt"     TIMESTAMPTZ,
  "createdAt"        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "bank_statements_tenantId_createdAt_idx"
  ON "bank_statements" ("tenantId", "createdAt" DESC);

-- Cada línea del cuadre: una operación del banco, un cobro de aquí que el
-- banco no tiene, o las dos casadas. tenantId = local al que se atribuye
-- (el del cobro; si solo está en el banco, el del datáfono o el que sube).
CREATE TABLE IF NOT EXISTS "bank_statement_items" (
  "id"              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "statementId"     UUID        NOT NULL REFERENCES "bank_statements"("id") ON DELETE CASCADE,
  "tenantId"        UUID        NOT NULL REFERENCES "venues"("id") ON DELETE CASCADE,
  "status"          TEXT        NOT NULL,
  "kind"            TEXT        NOT NULL CHECK ("kind" IN ('SALE', 'REFUND')),
  "line"            INTEGER,
  "occurredAt"      TIMESTAMPTZ,
  "bankAmountCents" INTEGER,
  "oursAmountCents" INTEGER,
  "reference"       TEXT,
  "terminal"        TEXT,
  "authCode"        TEXT,
  "paymentId"       UUID        REFERENCES "payments"("id") ON DELETE SET NULL,
  "refundId"        UUID        REFERENCES "refunds"("id") ON DELETE SET NULL,
  -- Un fichero posterior cubre su día: esta línea deja de contar.
  "supersededAt"    TIMESTAMPTZ,
  "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "bank_statement_items_statementId_idx"
  ON "bank_statement_items" ("statementId");
CREATE INDEX IF NOT EXISTS "bank_statement_items_tenantId_status_idx"
  ON "bank_statement_items" ("tenantId", "status");

-- ENABLE sin FORCE, como el resto (20260502000000_soften_rls_force).
ALTER TABLE "bank_statements" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bank_statements_tenant_isolation ON "bank_statements";
CREATE POLICY bank_statements_tenant_isolation ON "bank_statements"
  USING (app_rls_bypass() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_rls_bypass() OR "tenantId" = app_current_tenant());

ALTER TABLE "bank_statement_items" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bank_statement_items_tenant_isolation ON "bank_statement_items";
CREATE POLICY bank_statement_items_tenant_isolation ON "bank_statement_items"
  USING (app_rls_bypass() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_rls_bypass() OR "tenantId" = app_current_tenant());
