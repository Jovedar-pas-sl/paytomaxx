-- Fase 1E (2026-10-13) — bandeja de incidencias.
--
-- Las incidencias se calculan al vuelo (cobros atascados, dobles cobros,
-- descuentos que fallaron, noches cerradas con pendientes). Aquí solo se
-- guarda cuáles ha revisado ya el dueño, para quitarlas de la bandeja.
CREATE TABLE IF NOT EXISTS "incident_acks" (
  "id"       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID        NOT NULL REFERENCES "venues"("id") ON DELETE CASCADE,
  "kind"     TEXT        NOT NULL,
  "refId"    TEXT        NOT NULL,
  "ackedBy"  UUID,
  "note"     TEXT,
  "ackedAt"  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "incident_acks_tenantId_kind_refId_key"
  ON "incident_acks" ("tenantId", "kind", "refId");

-- ENABLE sin FORCE, como el resto (20260502000000_soften_rls_force).
ALTER TABLE "incident_acks" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS incident_acks_tenant_isolation ON "incident_acks";
CREATE POLICY incident_acks_tenant_isolation ON "incident_acks"
  USING (app_rls_bypass() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_rls_bypass() OR "tenantId" = app_current_tenant());
