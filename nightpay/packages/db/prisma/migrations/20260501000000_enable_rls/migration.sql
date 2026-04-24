-- ADR-002: Postgres RLS como defensa en profundidad sobre el middleware de app.
-- Nota: Prisma mantiene identificadores camelCase en Postgres (no snake_case por defecto),
-- por eso las referencias a columnas van entre comillas dobles ("tenantId").

CREATE OR REPLACE FUNCTION app_current_tenant()
RETURNS UUID
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  RETURN NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION app_rls_bypass()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  RETURN current_setting('app.bypass_rls', true) = 'on';
EXCEPTION WHEN others THEN
  RETURN FALSE;
END;
$$;

-- ============================================================================
-- Policies por tabla tenant-scoped
-- ============================================================================

-- users
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_tenant_isolation ON users;
CREATE POLICY users_tenant_isolation ON users
  USING (app_rls_bypass() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_rls_bypass() OR "tenantId" = app_current_tenant());

-- terminals
ALTER TABLE terminals ENABLE ROW LEVEL SECURITY;
ALTER TABLE terminals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS terminals_tenant_isolation ON terminals;
CREATE POLICY terminals_tenant_isolation ON terminals
  USING (app_rls_bypass() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_rls_bypass() OR "tenantId" = app_current_tenant());

-- gateway_credentials
ALTER TABLE gateway_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE gateway_credentials FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gateway_credentials_tenant_isolation ON gateway_credentials;
CREATE POLICY gateway_credentials_tenant_isolation ON gateway_credentials
  USING (app_rls_bypass() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_rls_bypass() OR "tenantId" = app_current_tenant());

-- payments
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payments_tenant_isolation ON payments;
CREATE POLICY payments_tenant_isolation ON payments
  USING (app_rls_bypass() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_rls_bypass() OR "tenantId" = app_current_tenant());

-- payment_events
ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_events_tenant_isolation ON payment_events;
CREATE POLICY payment_events_tenant_isolation ON payment_events
  USING (app_rls_bypass() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_rls_bypass() OR "tenantId" = app_current_tenant());

-- refunds
ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE refunds FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS refunds_tenant_isolation ON refunds;
CREATE POLICY refunds_tenant_isolation ON refunds
  USING (app_rls_bypass() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_rls_bypass() OR "tenantId" = app_current_tenant());

-- reconciliations
ALTER TABLE reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reconciliations_tenant_isolation ON reconciliations;
CREATE POLICY reconciliations_tenant_isolation ON reconciliations
  USING (app_rls_bypass() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_rls_bypass() OR "tenantId" = app_current_tenant());

COMMENT ON FUNCTION app_current_tenant() IS
  'Devuelve el tenant_id de la sesion actual (SET LOCAL app.current_tenant_id). Ver ADR-002.';
COMMENT ON FUNCTION app_rls_bypass() IS
  'Permite bypass de RLS cuando app.bypass_rls=on. Solo para seed/CLI/migraciones de sistema.';
