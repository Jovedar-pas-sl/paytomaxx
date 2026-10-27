-- «Liquidación OxioPay», ronda de revisión (2026-10-27):
--
--  1. oxiopay_settlement_settings: la SEMANA DE INICIO de las liquidaciones
--     (un lunes; una sola fila). Nada anterior se liquida ni entra como ajuste
--     ni se puede generar a mano. Vacía, el API la fija al arrancar con el
--     próximo lunes (la primera semana completa tras desplegar). La cambia el
--     super-admin con 2FA y motivo. Global: solo con bypass (como oxiopay_payee).
--  2. La referencia de una regenerada lleva «/R2», «/R3»… (antes «-2», que podía
--     chocar con el slug de otro local, p. ej. «luna-2»).
--
-- Solo toca tablas de la liquidación (nuevas y pequeñas). Si choca con el
-- lock_timeout (otra transacción con la tabla), se relanza el despliegue.
-- Idempotente.
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "oxiopay_settlement_settings" (
  "id"          SMALLINT    NOT NULL DEFAULT 1,
  "startWeek"   DATE        NOT NULL,
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedById" UUID,
  CONSTRAINT "oxiopay_settlement_settings_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "oxiopay_settlement_settings" DROP CONSTRAINT IF EXISTS "oxiopay_settlement_settings_single_row";
ALTER TABLE "oxiopay_settlement_settings" ADD CONSTRAINT "oxiopay_settlement_settings_single_row" CHECK ("id" = 1) NOT VALID;
ALTER TABLE "oxiopay_settlement_settings" VALIDATE CONSTRAINT "oxiopay_settlement_settings_single_row";
ALTER TABLE "oxiopay_settlement_settings" DROP CONSTRAINT IF EXISTS "oxiopay_settlement_settings_start_monday";
ALTER TABLE "oxiopay_settlement_settings" ADD CONSTRAINT "oxiopay_settlement_settings_start_monday"
  CHECK (EXTRACT(ISODOW FROM "startWeek") = 1) NOT VALID;
ALTER TABLE "oxiopay_settlement_settings" VALIDATE CONSTRAINT "oxiopay_settlement_settings_start_monday";

ALTER TABLE "oxiopay_settlement_settings" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS oxiopay_settlement_settings_bypass_only ON "oxiopay_settlement_settings";
CREATE POLICY oxiopay_settlement_settings_bypass_only ON "oxiopay_settlement_settings"
  USING (app_rls_bypass())
  WITH CHECK (app_rls_bypass());

ALTER TABLE "oxiopay_settlements" DROP CONSTRAINT IF EXISTS "oxiopay_settlements_reference_format";
ALTER TABLE "oxiopay_settlements" ADD CONSTRAINT "oxiopay_settlements_reference_format"
  CHECK ("reference" ~ '^OXP-[0-9]{4}-S[0-9]{2}-[A-Z0-9-]+(/R[0-9]+)?$' AND length("reference") <= 140) NOT VALID;
ALTER TABLE "oxiopay_settlements" VALIDATE CONSTRAINT "oxiopay_settlements_reference_format";
