-- RLS para operator_earnings y operator_payouts (defense-in-depth, ADR-002).
-- Forma idéntica a la migración 20260501000000_enable_rls.

ALTER TABLE operator_earnings ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_earnings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_earnings_tenant_isolation ON operator_earnings;
CREATE POLICY operator_earnings_tenant_isolation ON operator_earnings
  USING (app_rls_bypass() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_rls_bypass() OR "tenantId" = app_current_tenant());

ALTER TABLE operator_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_payouts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_payouts_tenant_isolation ON operator_payouts;
CREATE POLICY operator_payouts_tenant_isolation ON operator_payouts
  USING (app_rls_bypass() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_rls_bypass() OR "tenantId" = app_current_tenant());
