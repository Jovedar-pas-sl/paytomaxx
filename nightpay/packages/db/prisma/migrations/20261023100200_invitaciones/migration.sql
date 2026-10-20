-- «Invitar a una copa» (2026-10-23): el cliente invita a una chica a una copa
-- y la venta se reparte entre la chica invitada, el camarero que la cobra y
-- el local, según Ajustes.
--
--  1. service_items.isInvitation: las invitaciones de la carta (en Copas,
--     con su propio precio).
--  2. venues.invitationRules: la parte de la chica y la del camarero (% o
--     importe fijo); el resto es del local. NULL = de fábrica.
--  3. payment_lines: la chica invitada (beneficiaryOperatorId) y las partes
--     fijadas al cobrar (beneficiaryCents para ella, chargerCents para quien
--     cobró).
--  4. operator_earnings: un cobro (o consumo del saldo) puede dar ganancia a
--     más de una persona (la chica invitada y el camarero): único por cobro
--     y persona en vez de por cobro. paymentLineId marca la de la invitación.
--  5. earning_reversals: una devolución (o un consumo anulado) descuenta a
--     cada una: único por devolución y ganancia.
--
-- Idempotente. Los índices únicos nuevos se crean antes de quitar los viejos
-- (la base no se queda sin candado entre medias).

SET lock_timeout = '5s';

-- ─── 1 y 2. Carta y ajustes ─────────────────────────────────────────────

ALTER TABLE "service_items" ADD COLUMN IF NOT EXISTS "isInvitation" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "service_items" DROP CONSTRAINT IF EXISTS "service_items_invitation_in_copas";
ALTER TABLE "service_items" ADD CONSTRAINT "service_items_invitation_in_copas"
  CHECK (NOT "isInvitation" OR ("category" = 'VENUE_BAR' AND "components" IS NULL));

ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "invitationRules" JSONB;
ALTER TABLE "venues" DROP CONSTRAINT IF EXISTS "venues_invitation_rules_is_object";
ALTER TABLE "venues" ADD CONSTRAINT "venues_invitation_rules_is_object"
  CHECK ("invitationRules" IS NULL OR jsonb_typeof("invitationRules") = 'object');

-- ─── 3. Líneas de invitación ────────────────────────────────────────────

ALTER TABLE "payment_lines" ADD COLUMN IF NOT EXISTS "beneficiaryOperatorId" UUID;
ALTER TABLE "payment_lines" ADD COLUMN IF NOT EXISTS "beneficiaryCents" INTEGER;
ALTER TABLE "payment_lines" ADD COLUMN IF NOT EXISTS "chargerCents" INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_lines_beneficiaryOperatorId_fkey') THEN
    ALTER TABLE "payment_lines" ADD CONSTRAINT "payment_lines_beneficiaryOperatorId_fkey"
      FOREIGN KEY ("beneficiaryOperatorId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

-- Las partes, fijadas al cobrar: nunca más que la línea.
ALTER TABLE "payment_lines" DROP CONSTRAINT IF EXISTS "payment_lines_invitation_shares";
ALTER TABLE "payment_lines" ADD CONSTRAINT "payment_lines_invitation_shares"
  CHECK (
    ("beneficiaryCents" IS NULL AND "chargerCents" IS NULL)
    OR ("beneficiaryCents" >= 0 AND "chargerCents" >= 0 AND "beneficiaryCents" + "chargerCents" <= "amountCents")
  );

CREATE INDEX IF NOT EXISTS "payment_lines_beneficiaryOperatorId_idx" ON "payment_lines" ("beneficiaryOperatorId");

-- ─── 4. Ganancias: una por cobro (o consumo) y persona ──────────────────

ALTER TABLE "operator_earnings" ADD COLUMN IF NOT EXISTS "paymentLineId" UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'operator_earnings_paymentLineId_fkey') THEN
    ALTER TABLE "operator_earnings" ADD CONSTRAINT "operator_earnings_paymentLineId_fkey"
      FOREIGN KEY ("paymentLineId") REFERENCES "payment_lines" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "operator_earnings_paymentId_operatorId_key"
  ON "operator_earnings" ("paymentId", "operatorId");
CREATE UNIQUE INDEX IF NOT EXISTS "operator_earnings_consumptionId_operatorId_key"
  ON "operator_earnings" ("consumptionId", "operatorId");
ALTER TABLE "operator_earnings" DROP CONSTRAINT IF EXISTS "operator_earnings_paymentId_key";
DROP INDEX IF EXISTS "operator_earnings_paymentId_key";
ALTER TABLE "operator_earnings" DROP CONSTRAINT IF EXISTS "operator_earnings_consumptionId_key";
DROP INDEX IF EXISTS "operator_earnings_consumptionId_key";
-- Para buscar las de un cobro o un consumo (antes las daba el índice único).
CREATE INDEX IF NOT EXISTS "operator_earnings_paymentId_idx" ON "operator_earnings" ("paymentId");
CREATE INDEX IF NOT EXISTS "operator_earnings_consumptionId_idx" ON "operator_earnings" ("consumptionId");

-- ─── 5. Descuentos: uno por devolución (o consumo anulado) y ganancia ────

CREATE UNIQUE INDEX IF NOT EXISTS "earning_reversals_refundId_earningId_key"
  ON "earning_reversals" ("refundId", "earningId");
CREATE UNIQUE INDEX IF NOT EXISTS "earning_reversals_consumptionId_earningId_key"
  ON "earning_reversals" ("consumptionId", "earningId");
ALTER TABLE "earning_reversals" DROP CONSTRAINT IF EXISTS "earning_reversals_refundId_key";
DROP INDEX IF EXISTS "earning_reversals_refundId_key";
ALTER TABLE "earning_reversals" DROP CONSTRAINT IF EXISTS "earning_reversals_consumptionId_key";
DROP INDEX IF EXISTS "earning_reversals_consumptionId_key";
CREATE INDEX IF NOT EXISTS "earning_reversals_refundId_idx" ON "earning_reversals" ("refundId");
CREATE INDEX IF NOT EXISTS "earning_reversals_consumptionId_idx" ON "earning_reversals" ("consumptionId");
