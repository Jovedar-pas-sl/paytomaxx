-- OxioParty, la base (15-nov-2026; docs/OXIOPARTY.md): la versión de OxioPay
-- para fiestas (peñas, Fallas, bares) con pulsera NFC y saldo prepago. Es el
-- mismo código; se activa con EDITION=party. Con EDITION=club (OxioPay, por
-- defecto) nada de esto se usa: todo es nulable o tiene valor por defecto.
--
-- (Se llama 20261115… y no 20261113…: tiene que ordenarse después de la última
-- de main, 20261114100100_btcpay_tablas; ver scripts/check-migration-order.mjs.)
--
--   venues                    las fechas de la fiesta (con el fin ya pasado no
--                             hay cobros ni recargas nuevos: EVENT_ENDED), el
--                             último día para pedir la devolución del saldo,
--                             si se puede donar lo que sobra y el umbral del
--                             aviso de efectivo (2.000 € de serie).
--   stalls                    las casetas del local: responsable, la parte del
--                             organizador (organizerBps, de 0 a 10000; 10000 =
--                             «barra propia») y el IBAN de la caseta.
--   users."stallId"           la caseta en la que trabaja cada persona.
--   payments, wallet_charge_requests, wallet_consumptions ."stallId"
--                             la caseta del cobro, del cobro del saldo y del
--                             consumo, fijada al crearlos.
--
-- Columnas nuevas nulables o con un valor por defecto constante: en Postgres
-- 11+ no reescriben las tablas y el API anterior (start-first) sigue igual.
-- Las claves ajenas llevan el local (id, tenantId): una caseta nunca es de
-- otro local que la persona, el cobro o el consumo. Sobre las tablas grandes
-- van NOT VALID y luego VALIDATE (la columna es nueva, todo NULL: no bloquea
-- escrituras). ON DELETE RESTRICT: una caseta con cobros no se borra (se
-- desactiva). Los CHECK de venues, NOT VALID + VALIDATE como desde 20261029.
-- stalls con FORCE RLS como las demás tablas por local de octubre y noviembre.
-- Todo con IF NOT EXISTS: se puede repetir.

SET lock_timeout = '5s';

-- ─── venues: la fiesta ─────────────────────────────────────────────────

ALTER TABLE "venues"
  ADD COLUMN IF NOT EXISTS "eventStartsAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "eventEndsAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "refundDeadline" DATE,
  ADD COLUMN IF NOT EXISTS "allowDonation" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "cashAlertCents" INTEGER NOT NULL DEFAULT 200000;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'venues_event_window_check' AND conrelid = '"venues"'::regclass) THEN
    ALTER TABLE "venues"
      ADD CONSTRAINT "venues_event_window_check"
      CHECK ("eventStartsAt" IS NULL OR "eventEndsAt" IS NULL OR "eventEndsAt" > "eventStartsAt") NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'venues_cash_alert_check' AND conrelid = '"venues"'::regclass) THEN
    ALTER TABLE "venues"
      ADD CONSTRAINT "venues_cash_alert_check" CHECK ("cashAlertCents" BETWEEN 0 AND 100000000) NOT VALID;
  END IF;
END
$$;

ALTER TABLE "venues" VALIDATE CONSTRAINT "venues_event_window_check";
ALTER TABLE "venues" VALIDATE CONSTRAINT "venues_cash_alert_check";

-- ─── stalls: las casetas ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "stalls" (
  "id"             UUID        NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"       UUID        NOT NULL,
  "name"           TEXT        NOT NULL,
  "managerName"    TEXT        NOT NULL,
  "managerContact" TEXT,
  "organizerBps"   INTEGER     NOT NULL,
  "iban"           TEXT,
  "active"         BOOLEAN     NOT NULL DEFAULT true,
  "sortOrder"      INTEGER     NOT NULL DEFAULT 0,
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "stalls_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stalls_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- La parte del organizador: de 0 a 10000 (10000 = «barra propia»).
  CONSTRAINT "stalls_organizer_bps_range" CHECK ("organizerBps" BETWEEN 0 AND 10000),
  CONSTRAINT "stalls_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 80),
  CONSTRAINT "stalls_manager_name_check" CHECK (char_length(btrim("managerName")) BETWEEN 1 AND 120),
  CONSTRAINT "stalls_manager_contact_check"
    CHECK ("managerContact" IS NULL OR char_length(btrim("managerContact")) BETWEEN 1 AND 160),
  -- Como lo guarda el API: sin espacios y en mayúsculas (el dígito de control, mod-97, lo mira el API).
  CONSTRAINT "stalls_iban_format" CHECK ("iban" IS NULL OR "iban" ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$')
);

-- Para las claves ajenas compuestas (caseta, local).
CREATE UNIQUE INDEX IF NOT EXISTS "stalls_id_tenantId_key" ON "stalls"("id", "tenantId");
CREATE INDEX IF NOT EXISTS "stalls_tenantId_active_sortOrder_idx" ON "stalls"("tenantId", "active", "sortOrder");

ALTER TABLE "stalls" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stalls" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stalls_tenant_isolation ON "stalls";
CREATE POLICY stalls_tenant_isolation ON "stalls"
  USING ((SELECT app_rls_bypass()) OR "tenantId" = (SELECT app_current_tenant()))
  WITH CHECK ((SELECT app_rls_bypass()) OR "tenantId" = (SELECT app_current_tenant()));

-- ─── stallId: la persona, el cobro, el cobro del saldo y el consumo ────

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "stallId" UUID;
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "stallId" UUID;
ALTER TABLE "wallet_charge_requests" ADD COLUMN IF NOT EXISTS "stallId" UUID;
ALTER TABLE "wallet_consumptions" ADD COLUMN IF NOT EXISTS "stallId" UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_stallId_tenantId_fkey' AND conrelid = '"users"'::regclass) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_stallId_tenantId_fkey" FOREIGN KEY ("stallId", "tenantId")
      REFERENCES "stalls"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_stallId_tenantId_fkey' AND conrelid = '"payments"'::regclass) THEN
    ALTER TABLE "payments"
      ADD CONSTRAINT "payments_stallId_tenantId_fkey" FOREIGN KEY ("stallId", "tenantId")
      REFERENCES "stalls"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wallet_charge_requests_stallId_tenantId_fkey' AND conrelid = '"wallet_charge_requests"'::regclass
  ) THEN
    ALTER TABLE "wallet_charge_requests"
      ADD CONSTRAINT "wallet_charge_requests_stallId_tenantId_fkey" FOREIGN KEY ("stallId", "tenantId")
      REFERENCES "stalls"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wallet_consumptions_stallId_tenantId_fkey' AND conrelid = '"wallet_consumptions"'::regclass
  ) THEN
    ALTER TABLE "wallet_consumptions"
      ADD CONSTRAINT "wallet_consumptions_stallId_tenantId_fkey" FOREIGN KEY ("stallId", "tenantId")
      REFERENCES "stalls"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;
END
$$;

ALTER TABLE "users" VALIDATE CONSTRAINT "users_stallId_tenantId_fkey";
ALTER TABLE "payments" VALIDATE CONSTRAINT "payments_stallId_tenantId_fkey";
ALTER TABLE "wallet_charge_requests" VALIDATE CONSTRAINT "wallet_charge_requests_stallId_tenantId_fkey";
ALTER TABLE "wallet_consumptions" VALIDATE CONSTRAINT "wallet_consumptions_stallId_tenantId_fkey";
