-- El mapa del dinero (2026-10-23): cada cobro en su sección, con su chica,
-- su saldo y una referencia corta.
--
--  1. venues.sections: secciones del local (Servicios, Copas, Habitaciones,
--     Comida, Entradas) con { enabled, label, color }. NULL = las de fábrica
--     (packages/contracts/src/sections.ts). «Otros» (EXTRA) queda solo para
--     los cobros antiguos.
--  2. users.post: el puesto de cada persona (Sala, Barra, Habitaciones,
--     Cocina, Recepción). Da la sección por defecto de sus cobros (Sala →
--     Servicios, Barra → Copas…). NULL = el de su rol (chica → Sala, resto → Barra).
--  3. service_items.components: packs («1 h con habitación» = 120 € de
--     Servicios + 30 € de Habitaciones). La suma la comprueba el API.
--  4. payment_lines: las líneas de cada cobro (con tarjeta o del saldo), cada
--     una en su sección. La comisión de la chica se calcula por línea.
--  5. Referencia corta por local (C-0001) en cobros y cobros del saldo, de un
--     contador por local (charge_ref_counters) que se bloquea en la misma
--     transacción que crea el cobro. Las filas antiguas, sin referencia.
--
-- Idempotente y segura con datos: columnas nullable y tablas nuevas; nada se
-- reescribe.

-- Corre con el API anterior sirviendo (start-first): si una transacción suya
-- tiene la tabla, mejor fallar a los 5 s (el deploy se repite) que dejar
-- todas las escrituras en cola detrás de este ALTER.
SET lock_timeout = '5s';

-- ─── 1. Secciones del local ─────────────────────────────────────────────

ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "sections" JSONB;
ALTER TABLE "venues" DROP CONSTRAINT IF EXISTS "venues_sections_is_object";
ALTER TABLE "venues" ADD CONSTRAINT "venues_sections_is_object"
  CHECK ("sections" IS NULL OR jsonb_typeof("sections") = 'object');

-- ─── 2. Puesto de cada persona ──────────────────────────────────────────

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "post" TEXT;
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_post_valid";
ALTER TABLE "users" ADD CONSTRAINT "users_post_valid"
  CHECK ("post" IS NULL OR "post" IN ('SALA', 'BARRA', 'HABITACIONES', 'COCINA', 'RECEPCION'));

-- ─── 3. Packs de la carta ───────────────────────────────────────────────

ALTER TABLE "service_items" ADD COLUMN IF NOT EXISTS "components" JSONB;
ALTER TABLE "service_items" DROP CONSTRAINT IF EXISTS "service_items_components_is_array";
ALTER TABLE "service_items" ADD CONSTRAINT "service_items_components_is_array"
  CHECK ("components" IS NULL OR jsonb_typeof("components") = 'array');

-- ─── 4. Referencia corta ────────────────────────────────────────────────

ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "ref" INTEGER;
ALTER TABLE "wallet_charge_requests" ADD COLUMN IF NOT EXISTS "ref" INTEGER;
-- Una referencia por local (las filas antiguas, a NULL, no chocan).
CREATE UNIQUE INDEX IF NOT EXISTS "payments_tenantId_ref_key" ON "payments" ("tenantId", "ref");
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_charge_requests_tenantId_ref_key"
  ON "wallet_charge_requests" ("tenantId", "ref");

-- Un contador por local, compartido por cobros y cobros del saldo.
CREATE TABLE IF NOT EXISTS "charge_ref_counters" (
  "tenantId"  UUID        NOT NULL,
  "lastRef"   INTEGER     NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "charge_ref_counters_pkey" PRIMARY KEY ("tenantId")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'charge_ref_counters_tenantId_fkey') THEN
    ALTER TABLE "charge_ref_counters" ADD CONSTRAINT "charge_ref_counters_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "venues" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

ALTER TABLE "charge_ref_counters" DROP CONSTRAINT IF EXISTS "charge_ref_counters_last_ref_positive";
ALTER TABLE "charge_ref_counters" ADD CONSTRAINT "charge_ref_counters_last_ref_positive"
  CHECK ("lastRef" >= 0);

-- ─── 5. Líneas de cada cobro ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "payment_lines" (
  "id"                    UUID        NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"              UUID        NOT NULL,
  -- De un cobro con tarjeta (payments) o de un cobro del saldo (wallet_charge_requests).
  "paymentId"             UUID,
  "walletChargeId"        UUID,
  "category"              TEXT        NOT NULL,
  "serviceItemId"         UUID,
  "label"                 TEXT        NOT NULL,
  "qty"                   INTEGER     NOT NULL DEFAULT 1,
  "unitCents"             INTEGER     NOT NULL,
  "amountCents"           INTEGER     NOT NULL,
  -- % de la chica fijado al crear el cobro con tarjeta (null: no es de una
  -- chica, o un cobro del saldo, que lo calcula al pagarse).
  "operatorCommissionBps" INTEGER,
  "createdAt"             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "payment_lines_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_lines_tenantId_fkey') THEN
    ALTER TABLE "payment_lines" ADD CONSTRAINT "payment_lines_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "venues" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_lines_paymentId_fkey') THEN
    ALTER TABLE "payment_lines" ADD CONSTRAINT "payment_lines_paymentId_fkey"
      FOREIGN KEY ("paymentId") REFERENCES "payments" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_lines_walletChargeId_fkey') THEN
    ALTER TABLE "payment_lines" ADD CONSTRAINT "payment_lines_walletChargeId_fkey"
      FOREIGN KEY ("walletChargeId") REFERENCES "wallet_charge_requests" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_lines_serviceItemId_fkey') THEN
    ALTER TABLE "payment_lines" ADD CONSTRAINT "payment_lines_serviceItemId_fkey"
      FOREIGN KEY ("serviceItemId") REFERENCES "service_items" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

-- De un sitio y solo uno; nunca «Otros»; importe = unidades × precio.
ALTER TABLE "payment_lines" DROP CONSTRAINT IF EXISTS "payment_lines_one_source";
ALTER TABLE "payment_lines" ADD CONSTRAINT "payment_lines_one_source"
  CHECK (("paymentId" IS NULL) <> ("walletChargeId" IS NULL));
ALTER TABLE "payment_lines" DROP CONSTRAINT IF EXISTS "payment_lines_category_valid";
ALTER TABLE "payment_lines" ADD CONSTRAINT "payment_lines_category_valid"
  CHECK ("category" IN ('CHICA_SERVICE', 'VENUE_BAR', 'VENUE_ROOM', 'VENUE_FOOD', 'VENUE_ENTRY'));
ALTER TABLE "payment_lines" DROP CONSTRAINT IF EXISTS "payment_lines_amounts_valid";
ALTER TABLE "payment_lines" ADD CONSTRAINT "payment_lines_amounts_valid"
  CHECK ("qty" > 0 AND "unitCents" > 0 AND "amountCents" = "qty" * "unitCents");
ALTER TABLE "payment_lines" DROP CONSTRAINT IF EXISTS "payment_lines_bps_valid";
ALTER TABLE "payment_lines" ADD CONSTRAINT "payment_lines_bps_valid"
  CHECK ("operatorCommissionBps" IS NULL OR "operatorCommissionBps" BETWEEN 0 AND 10000);

CREATE INDEX IF NOT EXISTS "payment_lines_paymentId_idx" ON "payment_lines" ("paymentId");
CREATE INDEX IF NOT EXISTS "payment_lines_walletChargeId_idx" ON "payment_lines" ("walletChargeId");
CREATE INDEX IF NOT EXISTS "payment_lines_tenantId_createdAt_idx" ON "payment_lines" ("tenantId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "payment_lines_tenantId_category_idx" ON "payment_lines" ("tenantId", "category");

-- ─── RLS (FORCE), como el resto del dinero ──────────────────────────────
-- Con FORCE, una consulta sin el local en la sesión (o sin el bypass de
-- asSystem/acrossVenues) no ve nada, también con el rol dueño de las tablas,
-- y los guardas del API la cortan (apps/api/src/common/prisma/rls.ts).

ALTER TABLE "payment_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_lines_tenant_isolation ON "payment_lines";
CREATE POLICY payment_lines_tenant_isolation ON "payment_lines"
  USING (app_rls_bypass() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_rls_bypass() OR "tenantId" = app_current_tenant());

ALTER TABLE "charge_ref_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "charge_ref_counters" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS charge_ref_counters_tenant_isolation ON "charge_ref_counters";
CREATE POLICY charge_ref_counters_tenant_isolation ON "charge_ref_counters"
  USING (app_rls_bypass() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_rls_bypass() OR "tenantId" = app_current_tenant());
