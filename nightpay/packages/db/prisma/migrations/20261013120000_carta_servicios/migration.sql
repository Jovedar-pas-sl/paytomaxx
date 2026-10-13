-- Fase 1A (2026-10-13) — carta de servicios por local.
--
-- La chica elige un servicio ("30 min · 100 €") en vez de teclear un importe:
-- el precio y la categoría los pone el local, no quien cobra. El cobro guarda
-- una foto del servicio (nombre y duración) por si la carta cambia después.

CREATE TABLE IF NOT EXISTS "service_items" (
  "id"           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"     UUID        NOT NULL REFERENCES "venues"("id") ON DELETE CASCADE,
  "name"         TEXT        NOT NULL,
  "durationMin"  INTEGER,
  "priceCents"   INTEGER     NOT NULL CHECK ("priceCents" > 0),
  -- CHICA_SERVICE | VENUE_BAR | VENUE_ROOM | VENUE_FOOD | EXTRA
  "category"     TEXT        NOT NULL DEFAULT 'CHICA_SERVICE',
  "active"       BOOLEAN     NOT NULL DEFAULT true,
  "sortOrder"    INTEGER     NOT NULL DEFAULT 0,
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "service_items_tenantId_active_sortOrder_idx"
  ON "service_items" ("tenantId", "active", "sortOrder");

-- ENABLE sin FORCE, como payments/users/terminals (20260502000000_soften_rls_force):
-- la app conecta como owner y el aislamiento lo hace el middleware Prisma.
ALTER TABLE "service_items" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_items_tenant_isolation ON "service_items";
CREATE POLICY service_items_tenant_isolation ON "service_items"
  USING (app_rls_bypass() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_rls_bypass() OR "tenantId" = app_current_tenant());

-- Foto del servicio en el cobro.
ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "serviceItemId" UUID,
  ADD COLUMN IF NOT EXISTS "serviceName"   TEXT,
  ADD COLUMN IF NOT EXISTS "durationMin"   INTEGER;
