-- Reservados, respuestas del dueño (17-nov-2026):
--   venues "reservationsOpenMinute"  la hora de apertura del local (minutos desde
--          las 00:00; 1200 = 20:00): las 48 h y el «hasta 2 h antes» cuentan desde ella.
--   reservations "commissionVoidedAt" el local cambió la fecha o anuló: el RRPP
--          pierde la comisión (y si ya estaba apuntada, se anula del reparto).
--   reservations "noShowAuto"         «No vino» puesto solo a las 12:00 del día siguiente.
--   reservations status CLIENT_CANCELED  el cliente anula avisando con 48 h.
--   reservation_payments "cashTopUpId" el resto pagado en efectivo (una recarga en
--          efectivo del saldo del grupo: entra en la caja de la noche y en el cierre).
-- Columnas con valor por defecto constante (o NULL): no reescriben las tablas.
-- Se puede repetir.

SET lock_timeout = '5s';

ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "reservationsOpenMinute" INTEGER NOT NULL DEFAULT 1200;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'venues_reservations_open_minute_check') THEN
    ALTER TABLE "venues"
      ADD CONSTRAINT "venues_reservations_open_minute_check" CHECK ("reservationsOpenMinute" BETWEEN 0 AND 1439) NOT VALID;
  END IF;
END $$;
ALTER TABLE "venues" VALIDATE CONSTRAINT "venues_reservations_open_minute_check";

ALTER TABLE "reservations"
  ADD COLUMN IF NOT EXISTS "commissionVoidedAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "noShowAuto" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "reservations" DROP CONSTRAINT IF EXISTS "reservations_status_known";
ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_status_known"
  CHECK ("status" IN ('PENDING', 'DEPOSIT_PAID', 'PAID', 'ARRIVED', 'NO_SHOW', 'CANCELED', 'CLIENT_CANCELED')) NOT VALID;
ALTER TABLE "reservations" VALIDATE CONSTRAINT "reservations_status_known";

ALTER TABLE "reservation_payments" ALTER COLUMN "paymentId" DROP NOT NULL;
ALTER TABLE "reservation_payments"
  ADD COLUMN IF NOT EXISTS "cashTopUpId" UUID REFERENCES "wallet_cash_topups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS "reservation_payments_cashTopUpId_key" ON "reservation_payments" ("cashTopUpId");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reservation_payments_one_source') THEN
    ALTER TABLE "reservation_payments"
      ADD CONSTRAINT "reservation_payments_one_source" CHECK (("paymentId" IS NULL) <> ("cashTopUpId" IS NULL));
  END IF;
END $$;
