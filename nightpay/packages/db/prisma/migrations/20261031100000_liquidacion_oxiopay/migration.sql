-- «Liquidación OxioPay» (2026-10-27, apps/api/src/modules/oxiopay-settlements):
-- lo que cada local debe a OxioPay cada semana, de lunes 08:00 a lunes 08:00
-- (hora de Madrid). Es lo que el mapa del dinero pone como de OxioPay en esa
-- ventana: la comisión del servicio cobrada a los clientes menos la devuelta,
-- y la comisión de plataforma de siempre donde no hay comisión del servicio.
-- El local la paga por transferencia con la referencia de la liquidación y el
-- super-admin apunta lo recibido (con 2FA).
--
--   oxiopay_settlements          una por local y semana (una activa: índice
--                                parcial; anulada se puede regenerar: /R2…),
--                                cifras congeladas al emitirla y su desglose
--   oxiopay_settlement_payments  pagos apuntados (solo de añadir: trigger)
--   oxiopay_payee                la cuenta de OxioPay (una fila, id = 1)
--
-- Tablas nuevas: no se reescribe nada y el API anterior (start-first) no las
-- usa. Las liquidaciones y sus pagos con FORCE RLS por local (como
-- approval_requests: son dinero que el local debe); la cuenta de OxioPay es
-- global y solo se ve con bypass (como businesses). Los CHECK de importes y
-- estados los asegura la base aunque el API fallase. Idempotente.
SET lock_timeout = '5s';

DO $$
BEGIN
  CREATE TYPE "OxioPaySettlementStatus" AS ENUM ('ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID');
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

-- ─── oxiopay_settlements ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "oxiopay_settlements" (
  "id"               UUID                      NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"         UUID                      NOT NULL,
  "businessId"       UUID,
  "periodFrom"       TIMESTAMPTZ               NOT NULL,
  "periodTo"         TIMESTAMPTZ               NOT NULL,
  "isoYear"          INTEGER                   NOT NULL,
  "isoWeek"          INTEGER                   NOT NULL,
  "reference"        TEXT                      NOT NULL,
  "status"           "OxioPaySettlementStatus" NOT NULL DEFAULT 'ISSUED',
  "periodCents"      INTEGER                   NOT NULL,
  "adjustmentsCents" INTEGER                   NOT NULL DEFAULT 0,
  "totalCents"       INTEGER                   NOT NULL,
  "paidCents"        INTEGER                   NOT NULL DEFAULT 0,
  "moneyMapCents"    INTEGER                   NOT NULL,
  "breakdown"        JSONB                     NOT NULL,
  "auto"             BOOLEAN                   NOT NULL DEFAULT true,
  "generatedAt"      TIMESTAMPTZ               NOT NULL DEFAULT now(),
  "generatedById"    UUID,
  "replacesId"       UUID,
  "paidAt"           TIMESTAMPTZ,
  "voidedAt"         TIMESTAMPTZ,
  "voidedById"       UUID,
  "voidReason"       TEXT,
  "updatedAt"        TIMESTAMPTZ               NOT NULL DEFAULT now(),
  CONSTRAINT "oxiopay_settlements_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oxiopay_settlements_tenantId_fkey') THEN
    -- Un local con liquidaciones no se borra (se da de baja: deletedAt).
    ALTER TABLE "oxiopay_settlements" ADD CONSTRAINT "oxiopay_settlements_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "venues" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oxiopay_settlements_businessId_fkey') THEN
    ALTER TABLE "oxiopay_settlements" ADD CONSTRAINT "oxiopay_settlements_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "businesses" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "oxiopay_settlements_reference_key" ON "oxiopay_settlements" ("reference");
-- Para la clave compuesta de los pagos (un pago siempre del mismo local que su liquidación).
CREATE UNIQUE INDEX IF NOT EXISTS "oxiopay_settlements_id_tenantId_key" ON "oxiopay_settlements" ("id", "tenantId");
CREATE INDEX IF NOT EXISTS "oxiopay_settlements_tenantId_periodFrom_idx" ON "oxiopay_settlements" ("tenantId", "periodFrom" DESC);
CREATE INDEX IF NOT EXISTS "oxiopay_settlements_status_generatedAt_idx" ON "oxiopay_settlements" ("status", "generatedAt");
CREATE INDEX IF NOT EXISTS "oxiopay_settlements_businessId_idx" ON "oxiopay_settlements" ("businessId");
-- Una sola activa (no anulada) por local y semana: dos réplicas del repaso (o
-- el repaso y el super-admin a la vez) no la duplican aunque fallase el candado.
CREATE UNIQUE INDEX IF NOT EXISTS "oxiopay_settlements_one_active_per_week"
  ON "oxiopay_settlements" ("tenantId", "periodFrom")
  WHERE "status" <> 'VOID';

-- ─── Reglas que la base asegura sola ─────────────────────────────────────
ALTER TABLE "oxiopay_settlements" DROP CONSTRAINT IF EXISTS "oxiopay_settlements_period_order";
ALTER TABLE "oxiopay_settlements" ADD CONSTRAINT "oxiopay_settlements_period_order"
  CHECK ("periodTo" > "periodFrom") NOT VALID;
ALTER TABLE "oxiopay_settlements" VALIDATE CONSTRAINT "oxiopay_settlements_period_order";
ALTER TABLE "oxiopay_settlements" DROP CONSTRAINT IF EXISTS "oxiopay_settlements_iso_week_range";
ALTER TABLE "oxiopay_settlements" ADD CONSTRAINT "oxiopay_settlements_iso_week_range"
  CHECK ("isoWeek" BETWEEN 1 AND 53 AND "isoYear" BETWEEN 2000 AND 9999) NOT VALID;
ALTER TABLE "oxiopay_settlements" VALIDATE CONSTRAINT "oxiopay_settlements_iso_week_range";
ALTER TABLE "oxiopay_settlements" DROP CONSTRAINT IF EXISTS "oxiopay_settlements_reference_format";
ALTER TABLE "oxiopay_settlements" ADD CONSTRAINT "oxiopay_settlements_reference_format"
  CHECK ("reference" ~ '^OXP-[0-9]{4}-S[0-9]{2}-[A-Z0-9-]+(/R[0-9]+)?$' AND length("reference") <= 140) NOT VALID;
ALTER TABLE "oxiopay_settlements" VALIDATE CONSTRAINT "oxiopay_settlements_reference_format";
-- Solo se emite con algo que pagar; el total es la semana más los ajustes.
ALTER TABLE "oxiopay_settlements" DROP CONSTRAINT IF EXISTS "oxiopay_settlements_total_positive";
ALTER TABLE "oxiopay_settlements" ADD CONSTRAINT "oxiopay_settlements_total_positive"
  CHECK ("totalCents" > 0) NOT VALID;
ALTER TABLE "oxiopay_settlements" VALIDATE CONSTRAINT "oxiopay_settlements_total_positive";
ALTER TABLE "oxiopay_settlements" DROP CONSTRAINT IF EXISTS "oxiopay_settlements_total_sum";
ALTER TABLE "oxiopay_settlements" ADD CONSTRAINT "oxiopay_settlements_total_sum"
  CHECK ("totalCents" = "periodCents" + "adjustmentsCents") NOT VALID;
ALTER TABLE "oxiopay_settlements" VALIDATE CONSTRAINT "oxiopay_settlements_total_sum";
-- Nunca se apunta más de lo que se debe.
ALTER TABLE "oxiopay_settlements" DROP CONSTRAINT IF EXISTS "oxiopay_settlements_paid_range";
ALTER TABLE "oxiopay_settlements" ADD CONSTRAINT "oxiopay_settlements_paid_range"
  CHECK ("paidCents" >= 0 AND "paidCents" <= "totalCents") NOT VALID;
ALTER TABLE "oxiopay_settlements" VALIDATE CONSTRAINT "oxiopay_settlements_paid_range";
-- El estado casa con lo pagado: emitida = nada; en parte = algo; pagada = todo
-- (con su fecha); anulada = sin pagos, con fecha, quién y motivo.
ALTER TABLE "oxiopay_settlements" DROP CONSTRAINT IF EXISTS "oxiopay_settlements_status_consistent";
ALTER TABLE "oxiopay_settlements" ADD CONSTRAINT "oxiopay_settlements_status_consistent"
  CHECK (
    ("status" = 'ISSUED' AND "paidCents" = 0 AND "paidAt" IS NULL AND "voidedAt" IS NULL)
    OR ("status" = 'PARTIALLY_PAID' AND "paidCents" > 0 AND "paidCents" < "totalCents" AND "paidAt" IS NULL AND "voidedAt" IS NULL)
    OR ("status" = 'PAID' AND "paidCents" = "totalCents" AND "paidAt" IS NOT NULL AND "voidedAt" IS NULL)
    OR ("status" = 'VOID' AND "paidCents" = 0 AND "paidAt" IS NULL AND "voidedAt" IS NOT NULL
        AND "voidedById" IS NOT NULL AND length(btrim(coalesce("voidReason", ''))) >= 3)
  ) NOT VALID;
ALTER TABLE "oxiopay_settlements" VALIDATE CONSTRAINT "oxiopay_settlements_status_consistent";
ALTER TABLE "oxiopay_settlements" DROP CONSTRAINT IF EXISTS "oxiopay_settlements_breakdown_is_object";
ALTER TABLE "oxiopay_settlements" ADD CONSTRAINT "oxiopay_settlements_breakdown_is_object"
  CHECK (jsonb_typeof("breakdown") = 'object') NOT VALID;
ALTER TABLE "oxiopay_settlements" VALIDATE CONSTRAINT "oxiopay_settlements_breakdown_is_object";
-- La generada a mano lleva quién (el repaso del lunes, no).
ALTER TABLE "oxiopay_settlements" DROP CONSTRAINT IF EXISTS "oxiopay_settlements_manual_has_author";
ALTER TABLE "oxiopay_settlements" ADD CONSTRAINT "oxiopay_settlements_manual_has_author"
  CHECK ("auto" OR "generatedById" IS NOT NULL) NOT VALID;
ALTER TABLE "oxiopay_settlements" VALIDATE CONSTRAINT "oxiopay_settlements_manual_has_author";

-- ─── oxiopay_settlement_payments ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "oxiopay_settlement_payments" (
  "id"            UUID        NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"      UUID        NOT NULL,
  "settlementId"  UUID        NOT NULL,
  "amountCents"   INTEGER     NOT NULL,
  "paidOn"        DATE        NOT NULL,
  "bankReference" TEXT        NOT NULL,
  "reason"        TEXT,
  "recordedById"  UUID        NOT NULL,
  "recordedAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "oxiopay_settlement_payments_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oxiopay_settlement_payments_settlementId_tenantId_fkey') THEN
    ALTER TABLE "oxiopay_settlement_payments" ADD CONSTRAINT "oxiopay_settlement_payments_settlementId_tenantId_fkey"
      FOREIGN KEY ("settlementId", "tenantId") REFERENCES "oxiopay_settlements" ("id", "tenantId")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "oxiopay_settlement_payments_settlementId_idx" ON "oxiopay_settlement_payments" ("settlementId");
CREATE INDEX IF NOT EXISTS "oxiopay_settlement_payments_tenantId_idx" ON "oxiopay_settlement_payments" ("tenantId");

ALTER TABLE "oxiopay_settlement_payments" DROP CONSTRAINT IF EXISTS "oxiopay_settlement_payments_amount_positive";
ALTER TABLE "oxiopay_settlement_payments" ADD CONSTRAINT "oxiopay_settlement_payments_amount_positive"
  CHECK ("amountCents" > 0) NOT VALID;
ALTER TABLE "oxiopay_settlement_payments" VALIDATE CONSTRAINT "oxiopay_settlement_payments_amount_positive";
ALTER TABLE "oxiopay_settlement_payments" DROP CONSTRAINT IF EXISTS "oxiopay_settlement_payments_reference_length";
ALTER TABLE "oxiopay_settlement_payments" ADD CONSTRAINT "oxiopay_settlement_payments_reference_length"
  CHECK (length(btrim("bankReference")) BETWEEN 1 AND 140) NOT VALID;
ALTER TABLE "oxiopay_settlement_payments" VALIDATE CONSTRAINT "oxiopay_settlement_payments_reference_length";
ALTER TABLE "oxiopay_settlement_payments" DROP CONSTRAINT IF EXISTS "oxiopay_settlement_payments_reason_length";
ALTER TABLE "oxiopay_settlement_payments" ADD CONSTRAINT "oxiopay_settlement_payments_reason_length"
  CHECK ("reason" IS NULL OR length(btrim("reason")) BETWEEN 3 AND 500) NOT VALID;
ALTER TABLE "oxiopay_settlement_payments" VALIDATE CONSTRAINT "oxiopay_settlement_payments_reason_length";

-- Solo de añadir: un pago apuntado no se reescribe ni se borra (si estaba mal,
-- se ve en el registro; la liquidación no se puede anular con pagos).
CREATE OR REPLACE FUNCTION oxiopay_settlement_payments_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'oxiopay_settlement_payments es solo de añadir: % no permitido', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS oxiopay_settlement_payments_no_update_delete ON "oxiopay_settlement_payments";
CREATE TRIGGER oxiopay_settlement_payments_no_update_delete
  BEFORE UPDATE OR DELETE ON "oxiopay_settlement_payments"
  FOR EACH ROW EXECUTE FUNCTION oxiopay_settlement_payments_append_only();

-- ─── RLS (FORCE) ─────────────────────────────────────────────────────────
ALTER TABLE "oxiopay_settlements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "oxiopay_settlements" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS oxiopay_settlements_tenant_isolation ON "oxiopay_settlements";
CREATE POLICY oxiopay_settlements_tenant_isolation ON "oxiopay_settlements"
  USING (app_rls_bypass() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_rls_bypass() OR "tenantId" = app_current_tenant());

ALTER TABLE "oxiopay_settlement_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "oxiopay_settlement_payments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS oxiopay_settlement_payments_tenant_isolation ON "oxiopay_settlement_payments";
CREATE POLICY oxiopay_settlement_payments_tenant_isolation ON "oxiopay_settlement_payments"
  USING (app_rls_bypass() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_rls_bypass() OR "tenantId" = app_current_tenant());

-- ─── oxiopay_payee ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "oxiopay_payee" (
  "id"          SMALLINT    NOT NULL DEFAULT 1,
  "name"        TEXT        NOT NULL,
  "iban"        TEXT        NOT NULL,
  "holder"      TEXT        NOT NULL,
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedById" UUID,
  CONSTRAINT "oxiopay_payee_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "oxiopay_payee" DROP CONSTRAINT IF EXISTS "oxiopay_payee_single_row";
ALTER TABLE "oxiopay_payee" ADD CONSTRAINT "oxiopay_payee_single_row" CHECK ("id" = 1) NOT VALID;
ALTER TABLE "oxiopay_payee" VALIDATE CONSTRAINT "oxiopay_payee_single_row";
-- Como lo guarda el API: sin espacios, en mayúsculas (el dígito de control, mod-97, en el API).
ALTER TABLE "oxiopay_payee" DROP CONSTRAINT IF EXISTS "oxiopay_payee_iban_format";
ALTER TABLE "oxiopay_payee" ADD CONSTRAINT "oxiopay_payee_iban_format"
  CHECK ("iban" ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$') NOT VALID;
ALTER TABLE "oxiopay_payee" VALIDATE CONSTRAINT "oxiopay_payee_iban_format";
ALTER TABLE "oxiopay_payee" DROP CONSTRAINT IF EXISTS "oxiopay_payee_names_length";
ALTER TABLE "oxiopay_payee" ADD CONSTRAINT "oxiopay_payee_names_length"
  CHECK (length(btrim("name")) BETWEEN 2 AND 160 AND length(btrim("holder")) BETWEEN 2 AND 160) NOT VALID;
ALTER TABLE "oxiopay_payee" VALIDATE CONSTRAINT "oxiopay_payee_names_length";

-- Global y solo del super-admin (y del API para enseñarla al dueño): sin bypass
-- no se ve nada. Sin FORCE (como businesses).
ALTER TABLE "oxiopay_payee" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS oxiopay_payee_bypass_only ON "oxiopay_payee";
CREATE POLICY oxiopay_payee_bypass_only ON "oxiopay_payee"
  USING (app_rls_bypass())
  WITH CHECK (app_rls_bypass());
