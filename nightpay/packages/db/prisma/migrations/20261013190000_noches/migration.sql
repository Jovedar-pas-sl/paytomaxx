-- Fase 1D (2026-10-13) — la noche del local se abre y se cierra.
--
-- Al cerrar se guarda el informe Z congelado (totales, por tipo y por chica)
-- y ya no cambia aunque luego haya devoluciones. Solo puede haber una noche
-- abierta por local. Si nadie la cierra, se cierra sola a las 08:00.
CREATE TABLE IF NOT EXISTS "venue_nights" (
  "id"             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"       UUID        NOT NULL REFERENCES "venues"("id") ON DELETE CASCADE,
  "openedAt"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "openedBy"       UUID,
  "closedAt"       TIMESTAMPTZ,
  "closedBy"       UUID,
  "autoClosed"     BOOLEAN     NOT NULL DEFAULT false,
  "pendingAtClose" INTEGER     NOT NULL DEFAULT 0,
  "closeNote"      TEXT,
  "zReport"        JSONB,
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "venue_nights_one_open_per_venue"
  ON "venue_nights" ("tenantId") WHERE "closedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "venue_nights_tenantId_openedAt_idx"
  ON "venue_nights" ("tenantId", "openedAt" DESC);

-- ENABLE sin FORCE, como el resto (20260502000000_soften_rls_force).
ALTER TABLE "venue_nights" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS venue_nights_tenant_isolation ON "venue_nights";
CREATE POLICY venue_nights_tenant_isolation ON "venue_nights"
  USING (app_rls_bypass() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_rls_bypass() OR "tenantId" = app_current_tenant());
