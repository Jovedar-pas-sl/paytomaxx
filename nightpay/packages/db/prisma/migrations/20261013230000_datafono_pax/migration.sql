-- Datáfono PAX con la app NightPay (2026-10-13).
--
-- La app del datáfono manda el importe al lector por la Device API de Paytef
-- y nos devuelve el resultado: nadie teclea referencias.

-- Vinculación: el dueño genera un código en el panel, se teclea una vez en el
-- datáfono y este recibe su credencial (solo se guarda el hash).
ALTER TABLE "terminals"
  ADD COLUMN IF NOT EXISTS "deviceTokenHash"      TEXT,
  ADD COLUMN IF NOT EXISTS "devicePairedAt"       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "deviceLastSeenAt"     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "pairingCodeHash"      TEXT,
  ADD COLUMN IF NOT EXISTS "pairingCodeExpiresAt" TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS "terminals_deviceTokenHash_key"
  ON "terminals" ("deviceTokenHash") WHERE "deviceTokenHash" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "terminals_pairingCodeHash_key"
  ON "terminals" ("pairingCodeHash") WHERE "pairingCodeHash" IS NOT NULL;

-- Número de operación de Paytef del cobro y datáfono que lo cobró: una
-- operación de un datáfono solo puede pagar un cobro. (Los números de Paytef
-- no son únicos entre datáfonos ni comercios: la clave es el par.)
ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "posOperationNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "posTerminalId"      UUID;
CREATE UNIQUE INDEX IF NOT EXISTS "payments_posTerminalId_posOperationNumber_key"
  ON "payments" ("posTerminalId", "posOperationNumber")
  WHERE "posOperationNumber" IS NOT NULL;

-- Operaciones del datáfono según su propio cierre de jornada, para cuadrar:
-- una venta del datáfono que no está en NightPay sale en Incidencias.
CREATE TABLE IF NOT EXISTS "pos_terminal_ops" (
  "id"              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"        UUID        NOT NULL REFERENCES "venues"("id") ON DELETE CASCADE,
  "terminalId"      UUID        NOT NULL REFERENCES "terminals"("id") ON DELETE CASCADE,
  "operationNumber" TEXT        NOT NULL,
  "opType"          TEXT        NOT NULL,
  "amountCents"     INTEGER,
  "occurredAt"      TIMESTAMPTZ,
  "reportedAt"      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "pos_terminal_ops_terminalId_operationNumber_key"
  ON "pos_terminal_ops" ("terminalId", "operationNumber");

-- ENABLE sin FORCE, como el resto (20260502000000_soften_rls_force).
ALTER TABLE "pos_terminal_ops" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pos_terminal_ops_tenant_isolation ON "pos_terminal_ops";
CREATE POLICY pos_terminal_ops_tenant_isolation ON "pos_terminal_ops"
  USING (app_rls_bypass() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_rls_bypass() OR "tenantId" = app_current_tenant());
