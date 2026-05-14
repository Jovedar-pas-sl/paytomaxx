-- RLS hardening (C1, C2, M1, M4, H4, H5 del audit 2026-05-14)
--
-- C1: peanpe_calls tenía tenantId + securityToken pero SIN policy RLS
-- C2: earning_reversals tenía tenantId pero SIN policy RLS
-- M1: client_wallets + wallet_consumptions sin FORCE RLS (RLS bypaseable por superuser)
-- M4: client_wallets/wallet_consumptions usan current_setting directo en vez de app_current_tenant()
-- H4: falta CHECK (reversedCents >= 0 AND reversedCents <= commissionCents + tipCents)
-- H5: falta CHECK (totalCents > 0) en operator_payouts

-- ─── C1: peanpe_calls ──────────────────────────────────────────────────────
ALTER TABLE "peanpe_calls" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "peanpe_calls" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS peanpe_calls_tenant_isolation ON "peanpe_calls";
CREATE POLICY peanpe_calls_tenant_isolation ON "peanpe_calls"
  USING (app_rls_bypass() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_rls_bypass() OR "tenantId" = app_current_tenant());

-- ─── C2: earning_reversals ─────────────────────────────────────────────────
ALTER TABLE "earning_reversals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "earning_reversals" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS earning_reversals_tenant_isolation ON "earning_reversals";
CREATE POLICY earning_reversals_tenant_isolation ON "earning_reversals"
  USING (app_rls_bypass() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_rls_bypass() OR "tenantId" = app_current_tenant());

-- ─── M1+M4: client_wallets / wallet_consumptions ───────────────────────────
ALTER TABLE "client_wallets" FORCE ROW LEVEL SECURITY;
ALTER TABLE "wallet_consumptions" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS client_wallets_tenant_isolation ON "client_wallets";
CREATE POLICY client_wallets_tenant_isolation ON "client_wallets"
  USING (app_rls_bypass() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_rls_bypass() OR "tenantId" = app_current_tenant());

DROP POLICY IF EXISTS wallet_consumptions_tenant_isolation ON "wallet_consumptions";
CREATE POLICY wallet_consumptions_tenant_isolation ON "wallet_consumptions"
  USING (app_rls_bypass() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_rls_bypass() OR "tenantId" = app_current_tenant());

-- ─── H4: operator_earnings invariant ───────────────────────────────────────
-- reversedCents nunca negativo, nunca supera la comisión + tip total.
ALTER TABLE "operator_earnings"
  DROP CONSTRAINT IF EXISTS operator_earnings_reversed_bounded;
ALTER TABLE "operator_earnings"
  ADD CONSTRAINT operator_earnings_reversed_bounded
  CHECK ("reversedCents" >= 0 AND "reversedCents" <= "commissionCents" + COALESCE("tipCents", 0));

-- ─── H5: operator_payouts totalCents positivo ─────────────────────────────
ALTER TABLE "operator_payouts"
  DROP CONSTRAINT IF EXISTS operator_payouts_total_positive;
ALTER TABLE "operator_payouts"
  ADD CONSTRAINT operator_payouts_total_positive
  CHECK ("totalCents" > 0);
