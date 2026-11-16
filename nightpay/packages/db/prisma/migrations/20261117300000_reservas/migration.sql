-- Reservados con señal y enlaces de RRPP (17-nov-2026, apps/api/src/modules/reservations).
--
--   venues "reservationsEnabled"/"reservationsCode"  el enlace público del local
--          para reservar (/reservar/<código>): apagado de serie, código al azar.
--   reservation_packages  los paquetes que crea el dueño o el encargado: de cosas
--          fijas (ITEMS: entradas, botellas…) o de un importe para consumir
--          (CREDIT). Entradas = personas = un QR por persona.
--   promoters             los RRPP: una persona del equipo (cobra en el reparto de
--          siempre), su % del paquete y su enlace.
--   reservations          la reserva: copia del paquete al reservar, la noche, la
--          señal (30 %), lo pagado, «vendido por» (web, RRPP o panel), el saldo
--          del grupo y su estado.
--   reservation_guests    un QR por persona del grupo.
--   reservation_payments  cada pago con tarjeta (señal, resto o todo): un cobro de
--          recarga del saldo del grupo; cuenta como pagado SOLO con el aviso del
--          banco (lo apunta la transición del cobro, en su transacción).
--   reservation_spends    lo que gasta cada persona del grupo (cosas del paquete o
--          importe del saldo del grupo).
--
-- Tablas nuevas y dos columnas con valor por defecto constante en venues: no
-- reescriben nada ni bloquean el arranque. FORCE RLS en las seis tablas.
-- Se puede repetir.

SET lock_timeout = '5s';

ALTER TABLE "venues"
  ADD COLUMN IF NOT EXISTS "reservationsEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "reservationsCode" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "venues_reservationsCode_key" ON "venues"("reservationsCode");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'venues_reservations_code_check') THEN
    ALTER TABLE "venues"
      ADD CONSTRAINT "venues_reservations_code_check"
      CHECK (("reservationsCode" IS NULL OR "reservationsCode" ~ '^[A-Za-z0-9_-]{16}$')
             AND (NOT "reservationsEnabled" OR "reservationsCode" IS NOT NULL)) NOT VALID;
  END IF;
END $$;
ALTER TABLE "venues" VALIDATE CONSTRAINT "venues_reservations_code_check";

CREATE TABLE IF NOT EXISTS "reservation_packages" (
  "id"          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"    UUID        NOT NULL REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "name"        TEXT        NOT NULL,
  "kind"        TEXT        NOT NULL,
  "priceCents"  INTEGER     NOT NULL,
  "creditCents" INTEGER     NOT NULL DEFAULT 0,
  "entries"     INTEGER     NOT NULL,
  "items"       JSONB       NOT NULL DEFAULT '[]',
  "description" TEXT,
  "maxPerNight" INTEGER,
  "active"      BOOLEAN     NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "reservation_packages_name_len" CHECK (char_length("name") BETWEEN 1 AND 60),
  CONSTRAINT "reservation_packages_kind_known" CHECK ("kind" IN ('ITEMS', 'CREDIT')),
  CONSTRAINT "reservation_packages_price_range" CHECK ("priceCents" > 0 AND "priceCents" <= 1000000),
  CONSTRAINT "reservation_packages_credit_kind" CHECK (
    ("kind" = 'ITEMS' AND "creditCents" = 0) OR ("kind" = 'CREDIT' AND "creditCents" > 0 AND "creditCents" <= "priceCents")
  ),
  CONSTRAINT "reservation_packages_entries_range" CHECK ("entries" BETWEEN 1 AND 50),
  CONSTRAINT "reservation_packages_items_array" CHECK (jsonb_typeof("items") = 'array'),
  CONSTRAINT "reservation_packages_max_range" CHECK ("maxPerNight" IS NULL OR "maxPerNight" BETWEEN 1 AND 500)
);
CREATE INDEX IF NOT EXISTS "reservation_packages_tenantId_idx" ON "reservation_packages" ("tenantId");

CREATE TABLE IF NOT EXISTS "promoters" (
  "id"            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"      UUID        NOT NULL REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "userId"        UUID        NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "commissionBps" INTEGER     NOT NULL,
  "code"          TEXT        NOT NULL,
  "active"        BOOLEAN     NOT NULL DEFAULT true,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "promoters_bps_range" CHECK ("commissionBps" BETWEEN 0 AND 5000),
  CONSTRAINT "promoters_code_shape" CHECK ("code" ~ '^[A-Za-z0-9_-]{12}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS "promoters_code_key" ON "promoters" ("code");
CREATE UNIQUE INDEX IF NOT EXISTS "promoters_tenantId_userId_key" ON "promoters" ("tenantId", "userId");
CREATE INDEX IF NOT EXISTS "promoters_userId_idx" ON "promoters" ("userId");

CREATE TABLE IF NOT EXISTS "reservations" (
  "id"                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"           UUID        NOT NULL REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "ref"                TEXT        NOT NULL,
  "createKey"          TEXT        NOT NULL,
  "packageId"          UUID        NOT NULL REFERENCES "reservation_packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "packageName"        TEXT        NOT NULL,
  "kind"               TEXT        NOT NULL,
  "priceCents"         INTEGER     NOT NULL,
  "creditCents"        INTEGER     NOT NULL,
  "depositCents"       INTEGER     NOT NULL,
  "entries"            INTEGER     NOT NULL,
  "items"              JSONB       NOT NULL DEFAULT '[]',
  "nightDate"          DATE        NOT NULL,
  "previousNightDate"  DATE,
  "dateChangedAt"      TIMESTAMPTZ,
  "customerName"       TEXT        NOT NULL,
  "customerPhone"      VARCHAR(16),
  "notes"              TEXT,
  "status"             TEXT        NOT NULL DEFAULT 'PENDING',
  "paidCents"          INTEGER     NOT NULL DEFAULT 0,
  "source"             TEXT        NOT NULL,
  "promoterId"         UUID        REFERENCES "promoters"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "promoterBps"        INTEGER,
  "soldByUserId"       UUID,
  "commissionEarnedAt" TIMESTAMPTZ,
  "walletId"           UUID        REFERENCES "client_wallets"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "manageToken"        TEXT        NOT NULL,
  "tableLabel"         TEXT,
  "arrivedAt"          TIMESTAMPTZ,
  "arrivedByUserId"    UUID,
  "noShowAt"           TIMESTAMPTZ,
  "canceledAt"         TIMESTAMPTZ,
  "canceledByUserId"   UUID,
  "cancelReason"       TEXT,
  "recognizedAt"       TIMESTAMPTZ,
  "payAttempts"        INTEGER     NOT NULL DEFAULT 0,
  "createdAt"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "reservations_status_known" CHECK ("status" IN ('PENDING', 'DEPOSIT_PAID', 'PAID', 'ARRIVED', 'NO_SHOW', 'CANCELED')),
  CONSTRAINT "reservations_kind_known" CHECK ("kind" IN ('ITEMS', 'CREDIT')),
  CONSTRAINT "reservations_source_known" CHECK ("source" IN ('WEB', 'RRPP', 'PANEL')),
  CONSTRAINT "reservations_rrpp_has_promoter" CHECK (("source" = 'RRPP') = ("promoterId" IS NOT NULL)),
  CONSTRAINT "reservations_money" CHECK (
    "priceCents" > 0 AND "creditCents" >= 0 AND "creditCents" <= "priceCents"
    AND "depositCents" > 0 AND "depositCents" < "priceCents"
    AND "paidCents" >= 0 AND "paidCents" <= "priceCents"
  ),
  CONSTRAINT "reservations_entries_range" CHECK ("entries" BETWEEN 1 AND 50),
  CONSTRAINT "reservations_bps_range" CHECK ("promoterBps" IS NULL OR "promoterBps" BETWEEN 0 AND 5000),
  CONSTRAINT "reservations_ref_shape" CHECK ("ref" ~ '^[A-Z0-9]{6}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS "reservations_manageToken_key" ON "reservations" ("manageToken");
CREATE UNIQUE INDEX IF NOT EXISTS "reservations_tenantId_ref_key" ON "reservations" ("tenantId", "ref");
-- La misma reserva pedida dos veces (doble toque, la red): la misma fila.
CREATE UNIQUE INDEX IF NOT EXISTS "reservations_tenantId_createKey_key" ON "reservations" ("tenantId", "createKey");
CREATE INDEX IF NOT EXISTS "reservations_tenantId_nightDate_idx" ON "reservations" ("tenantId", "nightDate");
CREATE INDEX IF NOT EXISTS "reservations_tenantId_status_idx" ON "reservations" ("tenantId", "status");
CREATE INDEX IF NOT EXISTS "reservations_packageId_idx" ON "reservations" ("packageId");
CREATE INDEX IF NOT EXISTS "reservations_promoterId_idx" ON "reservations" ("promoterId");
CREATE INDEX IF NOT EXISTS "reservations_walletId_idx" ON "reservations" ("walletId");

CREATE TABLE IF NOT EXISTS "reservation_guests" (
  "id"            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"      UUID        NOT NULL REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "reservationId" UUID        NOT NULL REFERENCES "reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "seq"           INTEGER     NOT NULL,
  "label"         TEXT,
  "qrToken"       TEXT        NOT NULL,
  "checkedInAt"   TIMESTAMPTZ,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "reservation_guests_seq_range" CHECK ("seq" BETWEEN 1 AND 50)
);
CREATE UNIQUE INDEX IF NOT EXISTS "reservation_guests_qrToken_key" ON "reservation_guests" ("qrToken");
CREATE UNIQUE INDEX IF NOT EXISTS "reservation_guests_reservationId_seq_key" ON "reservation_guests" ("reservationId", "seq");
CREATE INDEX IF NOT EXISTS "reservation_guests_tenantId_idx" ON "reservation_guests" ("tenantId");

CREATE TABLE IF NOT EXISTS "reservation_payments" (
  "id"            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"      UUID        NOT NULL REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "reservationId" UUID        NOT NULL REFERENCES "reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "paymentId"     UUID        NOT NULL REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "kind"          TEXT        NOT NULL,
  "amountCents"   INTEGER     NOT NULL,
  "paidAt"        TIMESTAMPTZ,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "reservation_payments_kind_known" CHECK ("kind" IN ('DEPOSIT', 'REST', 'FULL')),
  CONSTRAINT "reservation_payments_amount_positive" CHECK ("amountCents" > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "reservation_payments_paymentId_key" ON "reservation_payments" ("paymentId");
CREATE INDEX IF NOT EXISTS "reservation_payments_reservationId_idx" ON "reservation_payments" ("reservationId");
CREATE INDEX IF NOT EXISTS "reservation_payments_tenantId_paidAt_idx" ON "reservation_payments" ("tenantId", "paidAt");

CREATE TABLE IF NOT EXISTS "reservation_spends" (
  "id"               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"         UUID        NOT NULL REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "reservationId"    UUID        NOT NULL REFERENCES "reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "guestId"          UUID        NOT NULL REFERENCES "reservation_guests"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "kind"             TEXT        NOT NULL,
  "itemName"         TEXT,
  "qty"              INTEGER,
  "amountCents"      INTEGER     NOT NULL DEFAULT 0,
  "consumptionId"    UUID        REFERENCES "wallet_consumptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "providedByUserId" UUID        NOT NULL,
  "idempotencyKey"   TEXT        NOT NULL,
  "createdAt"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "reservation_spends_shape" CHECK (
    ("kind" = 'ITEM' AND "itemName" IS NOT NULL AND "qty" > 0 AND "amountCents" = 0 AND "consumptionId" IS NULL)
    OR ("kind" = 'AMOUNT' AND "itemName" IS NULL AND "qty" IS NULL AND "amountCents" > 0 AND "consumptionId" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS "reservation_spends_consumptionId_key" ON "reservation_spends" ("consumptionId");
CREATE UNIQUE INDEX IF NOT EXISTS "reservation_spends_tenantId_idempotencyKey_key" ON "reservation_spends" ("tenantId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "reservation_spends_reservationId_idx" ON "reservation_spends" ("reservationId");
CREATE INDEX IF NOT EXISTS "reservation_spends_guestId_idx" ON "reservation_spends" ("guestId");

-- FORCE RLS: el local de la sesión o el bypass (como btcpay_*).
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['reservation_packages', 'promoters', 'reservations', 'reservation_guests', 'reservation_payments', 'reservation_spends']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ((SELECT app_rls_bypass()) OR "tenantId" = (SELECT app_current_tenant())) '
      'WITH CHECK ((SELECT app_rls_bypass()) OR "tenantId" = (SELECT app_current_tenant()))',
      t || '_tenant_isolation', t);
  END LOOP;
END $$;
