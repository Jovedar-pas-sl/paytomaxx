-- Consola del super-admin (2026-10-16): negocios clientes y reglas por local.
--
--  - businesses: los negocios que usan OxioPay (razón social, NIF/CIF,
--    contacto, pausa, comisión por defecto). Tabla global, sin local: solo la
--    ve el super-admin (acrossVenues). RLS activada sin FORCE, como users.
--  - venues: a qué negocio pertenece, pausa del local, IBAN de liquidación del
--    banco (cuadre e informes), días de espera para pagar a las chicas (null =
--    PAYOUT_HOLD_DAYS del entorno) y las reglas de aprobación (las aplicará la
--    bandeja de aprobaciones; aquí solo se guardan).
--
-- Idempotente y segura con datos: columnas nuevas nullable o con DEFAULT,
-- nada se borra ni se reescribe. Los CHECK solo miran columnas nuevas.

-- Corre con el API anterior sirviendo (start-first): si una transacción suya
-- tiene la tabla, mejor fallar a los 5 s (el deploy se repite) que dejar
-- todas las escrituras en cola detrás de este ALTER.
SET lock_timeout = '5s';

-- ─── Estado del negocio ──────────────────────────────────────────────────
DO $$
BEGIN
  CREATE TYPE "BusinessStatus" AS ENUM ('ACTIVE', 'PAUSED');
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

-- ─── businesses ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "businesses" (
  "id"                           UUID NOT NULL DEFAULT gen_random_uuid(),
  -- Razón social.
  "name"                         TEXT NOT NULL,
  -- NIF/CIF, en mayúsculas y sin espacios ni guiones (único si está).
  "taxId"                        TEXT,
  "contactName"                  TEXT,
  "contactEmail"                 TEXT,
  "contactPhone"                 TEXT,
  "notes"                        TEXT,
  "status"                       "BusinessStatus" NOT NULL DEFAULT 'ACTIVE',
  "pausedAt"                     TIMESTAMPTZ,
  "pausedReason"                 TEXT,
  -- Comisión de la plataforma para los locales nuevos del negocio (null = la general).
  "defaultPlatformCommissionBps" INTEGER,
  "createdAt"                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "businesses_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "businesses_taxId_key" ON "businesses" ("taxId");

ALTER TABLE "businesses" DROP CONSTRAINT IF EXISTS "businesses_commission_range";
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_commission_range"
  CHECK ("defaultPlatformCommissionBps" IS NULL OR "defaultPlatformCommissionBps" BETWEEN 0 AND 10000);

-- Global y solo del super-admin: sin bypass no se ve nada. Sin FORCE (como
-- users): el dueño de la tabla no pasa por la política.
ALTER TABLE "businesses" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS businesses_superadmin_only ON "businesses";
CREATE POLICY businesses_superadmin_only ON "businesses"
  USING (app_rls_bypass())
  WITH CHECK (app_rls_bypass());

-- ─── venues: negocio, pausa, IBAN y reglas ───────────────────────────────
ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "businessId" UUID;
ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "pausedAt" TIMESTAMPTZ;
ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "pausedReason" TEXT;
-- IBAN donde el banco liquida los cobros con tarjeta (sin espacios, validado mod-97 en el API).
ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "settlementIban" TEXT;
ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "settlementHolder" TEXT;
-- Días de espera antes de pagar a las chicas; null = PAYOUT_HOLD_DAYS. 0 = al cierre de la noche.
ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "payoutHoldDays" INTEGER;
-- Devoluciones desde este importe las pide el encargado y las aprueba el dueño con 2FA.
ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "refundApprovalThresholdCents" INTEGER NOT NULL DEFAULT 10000;
-- Pagos a las chicas: los pide el encargado y los aprueba el dueño con 2FA.
ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "payoutRequiresApproval" BOOLEAN NOT NULL DEFAULT true;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'venues_businessId_fkey') THEN
    ALTER TABLE "venues" ADD CONSTRAINT "venues_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "businesses" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS "venues_businessId_idx" ON "venues" ("businessId");

ALTER TABLE "venues" DROP CONSTRAINT IF EXISTS "venues_payout_hold_days_range";
ALTER TABLE "venues" ADD CONSTRAINT "venues_payout_hold_days_range"
  CHECK ("payoutHoldDays" IS NULL OR "payoutHoldDays" BETWEEN 0 AND 60);
ALTER TABLE "venues" DROP CONSTRAINT IF EXISTS "venues_refund_threshold_nonneg";
ALTER TABLE "venues" ADD CONSTRAINT "venues_refund_threshold_nonneg"
  CHECK ("refundApprovalThresholdCents" >= 0);
